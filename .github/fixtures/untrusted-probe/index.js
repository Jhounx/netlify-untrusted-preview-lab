const normalizeApiHost = (apiHost) =>
  /^https?:\/\//i.test(apiHost || '') ? apiHost : `https://${apiHost || 'api.netlify.com'}`

const requestJson = async ({ method = 'GET', url, token, body }) => {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch {}
    return { status: response.status, ok: response.ok, body: parsed }
  } catch (error) {
    return {
      status: null,
      ok: false,
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
      body: null,
    }
  }
}

export const onPostBuild = async ({ constants }) => {
  const token = constants.NETLIFY_API_TOKEN
  const siteId = constants.SITE_ID
  const apiHost = normalizeApiHost(constants.NETLIFY_API_HOST)
  const commitClass = String(process.env.COMMIT_REF || 'unknown').slice(0, 12)
  const title = `NETLIFY_UNTRUSTED_SNIPPET_CANARY_${commitClass}`
  const general = `<!-- controlled-inert-snippet-canary-${commitClass} -->`
  const result = {
    schema: 'netlify-untrusted-snippet-write-boundary.v1',
    context: process.env.CONTEXT || null,
    reviewIdPresent: Boolean(process.env.REVIEW_ID),
    requiredConstantsPresent:
      typeof token === 'string' && token.length > 0 && typeof siteId === 'string' && siteId.length > 0,
    inertHtmlCommentOnly: true,
    executableScriptPresent: false,
    externalRequestPresent: false,
    syntheticOnly: true,
  }

  if (!result.requiredConstantsPresent || process.env.CONTEXT !== 'deploy-preview') {
    console.log(`NETLIFY_UNTRUSTED_SNIPPET_PROBE ${JSON.stringify(result)}`)
    return
  }

  const site = await requestJson({
    url: new URL(`/api/v1/sites/${encodeURIComponent(siteId)}`, apiHost),
    token,
  })
  result.policy = {
    status: site.status,
    untrustedFlow:
      typeof site.body?.build_settings?.untrusted_flow === 'string'
        ? site.body.build_settings.untrusted_flow
        : null,
    publicRepo: site.body?.build_settings?.public_repo === true,
  }

  const collectionUrl = new URL(`/api/v1/sites/${encodeURIComponent(siteId)}/snippets`, apiHost)
  const baseline = await requestJson({ url: collectionUrl, token })
  result.baseline = {
    status: baseline.status,
    returnedArray: Array.isArray(baseline.body),
    exactCanaryPresent: Array.isArray(baseline.body)
      ? baseline.body.some((snippet) => snippet?.title === title)
      : null,
  }

  let createdId = null
  try {
    const created = await requestJson({
      method: 'POST',
      url: collectionUrl,
      token,
      body: {
        title,
        general,
        general_position: 'head',
        goal: '',
        goal_position: 'head',
      },
    })
    const candidateId = created.body?.id
    createdId =
      (typeof candidateId === 'number' && Number.isInteger(candidateId)) ||
      (typeof candidateId === 'string' && candidateId.length > 0)
        ? String(candidateId)
        : null
    result.create = {
      status: created.status,
      accepted: created.ok,
      idPresent: createdId !== null,
      returnedExpectedSite: created.body?.site_id === siteId,
      returnedExpectedTitle: created.body?.title === title,
      returnedInertContent: created.body?.general === general,
      returnedExpectedPosition: created.body?.general_position === 'head',
    }

    if (createdId) {
      const itemUrl = new URL(
        `/api/v1/sites/${encodeURIComponent(siteId)}/snippets/${encodeURIComponent(createdId)}`,
        apiHost,
      )
      const readback = await requestJson({ url: itemUrl, token })
      result.readback = {
        status: readback.status,
        returnedExpectedId: String(readback.body?.id) === createdId,
        returnedExpectedSite: readback.body?.site_id === siteId,
        returnedExpectedTitle: readback.body?.title === title,
        returnedInertContent: readback.body?.general === general,
      }
    }
  } finally {
    if (createdId) {
      const itemUrl = new URL(
        `/api/v1/sites/${encodeURIComponent(siteId)}/snippets/${encodeURIComponent(createdId)}`,
        apiHost,
      )
      const removed = await requestJson({ method: 'DELETE', url: itemUrl, token })
      result.cleanup = { attempted: true, status: removed.status, accepted: removed.ok }
    } else {
      result.cleanup = { attempted: false }
    }
  }

  const finalList = await requestJson({ url: collectionUrl, token })
  result.finalReadback = {
    status: finalList.status,
    returnedArray: Array.isArray(finalList.body),
    exactCanaryPresent: Array.isArray(finalList.body)
      ? finalList.body.some((snippet) => snippet?.title === title)
      : null,
  }

  console.log(`NETLIFY_UNTRUSTED_SNIPPET_PROBE ${JSON.stringify(result)}`)
}
