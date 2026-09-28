const CANARY_KEY = 'NETLIFY_UNTRUSTED_SITE_WRITE_CANARY_V1'
const CANARY_VALUE = 'synthetic-no-authority-untrusted-site-write-canary-v1'
const CANARY_BRANCH = '__never_build_untrusted_canary_v1'
const CONTROLLED_SIBLING_SITE_ID = 'a13832a0-b3f7-40cb-a07f-df10e6929241'

const normalizeApiHost = (apiHost) =>
  /^https?:\/\//i.test(apiHost || '') ? apiHost : `https://${apiHost || 'api.netlify.com'}`

const requestJson = async ({ url, token, method = 'GET', body }) => {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch {}
    return { status: response.status, ok: response.ok, parsed }
  } catch (error) {
    return {
      status: null,
      ok: false,
      parsed: null,
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
    }
  }
}

const envEndpoint = ({ apiHost, accountId, siteId, includeKey = false }) => {
  const suffix = includeKey ? `/env/${encodeURIComponent(CANARY_KEY)}` : '/env'
  const endpoint = new URL(`/api/v1/accounts/${encodeURIComponent(accountId)}${suffix}`, apiHost)
  endpoint.searchParams.set('site_id', siteId)
  return endpoint
}

const readCanaryMetadata = async ({ token, apiHost, accountId, siteId }) => {
  const response = await requestJson({
    url: envEndpoint({ apiHost, accountId, siteId, includeKey: true }),
    token,
  })
  const body = response.parsed
  return {
    status: response.status,
    requestFailed: response.requestFailed === true,
    keyPresent: body?.key === CANARY_KEY,
    buildsScopePresent: Array.isArray(body?.scopes) && body.scopes.includes('builds'),
    branchContextPresent:
      Array.isArray(body?.values) &&
      body.values.some(
        (item) => item?.context === 'branch' && item?.context_parameter === CANARY_BRANCH,
      ),
  }
}

const createCanary = async ({ token, apiHost, accountId, siteId }) => {
  const response = await requestJson({
    url: envEndpoint({ apiHost, accountId, siteId }),
    token,
    method: 'POST',
    body: [
      {
        key: CANARY_KEY,
        scopes: ['builds'],
        values: [
          {
            context: 'branch',
            context_parameter: CANARY_BRANCH,
            value: CANARY_VALUE,
          },
        ],
        is_secret: false,
      },
    ],
  })
  return {
    status: response.status,
    accepted: response.ok,
    requestFailed: response.requestFailed === true,
  }
}

const deleteCanary = async ({ token, apiHost, accountId, siteId }) => {
  const response = await requestJson({
    url: envEndpoint({ apiHost, accountId, siteId, includeKey: true }),
    token,
    method: 'DELETE',
  })
  return {
    status: response.status,
    accepted: response.ok,
    requestFailed: response.requestFailed === true,
  }
}

const runSiteWriteCanary = async ({ token, apiHost, accountId, siteId }) => {
  const result = {
    baseline: await readCanaryMetadata({ token, apiHost, accountId, siteId }),
    create: null,
    readback: null,
    cleanup: null,
    finalReadback: null,
  }
  if (result.baseline.keyPresent) {
    result.skipped = 'preexisting-key'
    return result
  }

  try {
    result.create = await createCanary({ token, apiHost, accountId, siteId })
    result.readback = await readCanaryMetadata({ token, apiHost, accountId, siteId })
  } finally {
    result.cleanup = await deleteCanary({ token, apiHost, accountId, siteId })
    result.finalReadback = await readCanaryMetadata({ token, apiHost, accountId, siteId })
  }

  result.persistenceObserved = result.readback.keyPresent === true
  result.cleanupObserved = result.finalReadback.keyPresent === false
  return result
}

const readSitePolicy = async ({ token, siteId, apiHost }) => {
  const endpoint = new URL(`/api/v1/sites/${encodeURIComponent(siteId)}`, apiHost)
  const response = await requestJson({ url: endpoint, token })
  return {
    status: response.status,
    untrustedFlow:
      typeof response.parsed?.build_settings?.untrusted_flow === 'string'
        ? response.parsed.build_settings.untrusted_flow
        : null,
    publicRepo: response.parsed?.build_settings?.public_repo === true,
  }
}

export const onPostBuild = async ({ constants }) => {
  const token = constants.NETLIFY_API_TOKEN
  const siteId = constants.SITE_ID
  const accountId = constants.ACCOUNT_ID
  const apiHost = normalizeApiHost(constants.NETLIFY_API_HOST)
  const prerequisites = {
    tokenPresent: typeof token === 'string' && token.length > 0,
    siteIdPresent: typeof siteId === 'string' && siteId.length > 0,
    accountIdPresent: typeof accountId === 'string' && accountId.length > 0,
  }
  const result = {
    phase: 'untrusted-plugin-site-write-boundary-v4',
    context: process.env.CONTEXT || null,
    reviewIdPresent: Boolean(process.env.REVIEW_ID),
    prerequisites,
    policy: null,
    ownSite: null,
    controlledSiblingSite: null,
    accountScopedWriteAttempted: false,
    canaryContainsCredentialMaterial: false,
    rawCredentialLogged: false,
  }

  if (!prerequisites.tokenPresent || !prerequisites.siteIdPresent || !prerequisites.accountIdPresent) {
    console.log(`NETLIFY_UNTRUSTED_SITE_WRITE_PROBE ${JSON.stringify(result)}`)
    return
  }

  result.policy = await readSitePolicy({ token, siteId, apiHost })
  if (process.env.CONTEXT !== 'deploy-preview' || result.policy.untrustedFlow !== 'redact') {
    console.log(`NETLIFY_UNTRUSTED_SITE_WRITE_PROBE ${JSON.stringify(result)}`)
    return
  }

  result.ownSite = await runSiteWriteCanary({ token, apiHost, accountId, siteId })
  result.controlledSiblingSite = await runSiteWriteCanary({
    token,
    apiHost,
    accountId,
    siteId: CONTROLLED_SIBLING_SITE_ID,
  })
  console.log(`NETLIFY_UNTRUSTED_SITE_WRITE_PROBE ${JSON.stringify(result)}`)
}
