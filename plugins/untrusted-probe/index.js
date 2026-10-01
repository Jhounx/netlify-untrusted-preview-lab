const TARGET_COMMIT_REF = '5302cfe62a6bedca234d2409ed48f1097fe27503'

const printResult = (result) => {
  console.log(`NETLIFY_UNTRUSTED_PROVENANCE_PROBE ${JSON.stringify(result)}`)
}

export const onSuccess = async ({ constants }) => {
  const token = constants.NETLIFY_API_TOKEN
  const siteId = constants.SITE_ID
  const deployId = process.env.DEPLOY_ID
  const apiHost = constants.NETLIFY_API_HOST || 'https://api.netlify.com'
  const result = {
    schema: 'netlify-untrusted-provenance-probe.v1',
    syntheticOnly: true,
    phase: 'onSuccess-after-core-deploy',
    targetCommitRef: TARGET_COMMIT_REF,
    tokenPresent: typeof token === 'string' && token.length > 0,
    siteIdPresent: typeof siteId === 'string' && siteId.length > 0,
    deployIdPresent: typeof deployId === 'string' && deployId.length > 0,
    requestAttempted: false,
    httpStatus: null,
    responseCommitRef: null,
    responseCommitUrlMatchesTarget: null,
    responseBranch: null,
    responseContext: null,
    responseReviewIdPresent: null,
  }

  if (!result.tokenPresent || !result.siteIdPresent || !result.deployIdPresent) {
    printResult(result)
    return
  }

  const normalizedHost = /^https?:\/\//i.test(apiHost) ? apiHost : `https://${apiHost}`
  const endpoint = new URL(
    `/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}`,
    normalizedHost,
  )
  endpoint.searchParams.set('commit_ref', TARGET_COMMIT_REF)

  try {
    result.requestAttempted = true
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: {} }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })

    result.httpStatus = response.status
    if (response.ok) {
      const body = await response.json()
      result.responseCommitRef = body?.commit_ref ?? null
      result.responseCommitUrlMatchesTarget =
        typeof body?.commit_url === 'string' && body.commit_url.endsWith(`/commit/${TARGET_COMMIT_REF}`)
      result.responseBranch = body?.branch ?? null
      result.responseContext = body?.context ?? null
      result.responseReviewIdPresent = body?.review_id !== null && body?.review_id !== undefined
    }
  } catch (error) {
    result.errorClass = error?.constructor?.name ?? 'UnknownError'
  }

  printResult(result)
}
