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
  const title = `NETLIFY_UNTRUSTED_BUILD_HOOK_CANARY_${commitClass}`
  const branch = `__never_build_untrusted_hook_${commitClass}`
  const result = {
    schema: 'netlify-untrusted-build-hook-write-boundary.v1',
    context: process.env.CONTEXT || null,
    reviewIdPresent: Boolean(process.env.REVIEW_ID),
    requiredConstantsPresent:
      typeof token === 'string' && token.length > 0 && typeof siteId === 'string' && siteId.length > 0,
    hookUrlLogged: false,
    hookInvoked: false,
    syntheticOnly: true,
  }

  if (!result.requiredConstantsPresent || process.env.CONTEXT !== 'deploy-preview') {
    console.log(`NETLIFY_UNTRUSTED_BUILD_HOOK_PROBE ${JSON.stringify(result)}`)
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

  const collectionUrl = new URL(`/api/v1/sites/${encodeURIComponent(siteId)}/build_hooks`, apiHost)
  const baseline = await requestJson({ url: collectionUrl, token })
  result.baseline = {
    status: baseline.status,
    returnedArray: Array.isArray(baseline.body),
    exactCanaryPresent: Array.isArray(baseline.body)
      ? baseline.body.some((hook) => hook?.title === title && hook?.branch === branch)
      : null,
  }

  let createdId = null
  try {
    const created = await requestJson({
      method: 'POST',
      url: collectionUrl,
      token,
      body: { title, branch },
    })
    createdId = typeof created.body?.id === 'string' && created.body.id.length > 0 ? created.body.id : null
    result.create = {
      status: created.status,
      accepted: created.ok,
      idPresent: createdId !== null,
      urlPresent: typeof created.body?.url === 'string' && created.body.url.length > 0,
      returnedExpectedSite: created.body?.site_id === siteId,
      returnedExpectedTitle: created.body?.title === title,
      returnedExpectedBranch: created.body?.branch === branch,
    }

    if (createdId) {
      const itemUrl = new URL(
        `/api/v1/sites/${encodeURIComponent(siteId)}/build_hooks/${encodeURIComponent(createdId)}`,
        apiHost,
      )
      const readback = await requestJson({ url: itemUrl, token })
      result.readback = {
        status: readback.status,
        returnedExpectedId: readback.body?.id === createdId,
        returnedExpectedTitle: readback.body?.title === title,
        returnedExpectedBranch: readback.body?.branch === branch,
        urlPresent: typeof readback.body?.url === 'string' && readback.body.url.length > 0,
      }
    }
  } finally {
    if (createdId) {
      const itemUrl = new URL(
        `/api/v1/sites/${encodeURIComponent(siteId)}/build_hooks/${encodeURIComponent(createdId)}`,
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
      ? finalList.body.some((hook) => hook?.title === title && hook?.branch === branch)
      : null,
  }

  console.log(`NETLIFY_UNTRUSTED_BUILD_HOOK_PROBE ${JSON.stringify(result)}`)
}
