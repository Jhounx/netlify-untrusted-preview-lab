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
  const title = `NETLIFY_UNTRUSTED_DRAFT_CANARY_${commitClass}`
  const branch = `__never_build_untrusted_draft_${commitClass}`
  const result = {
    schema: 'netlify-untrusted-rest-draft-deploy-boundary.v1',
    context: process.env.CONTEXT || null,
    reviewIdPresent: Boolean(process.env.REVIEW_ID),
    requiredConstantsPresent:
      typeof token === 'string' && token.length > 0 && typeof siteId === 'string' && siteId.length > 0,
    draftRequested: true,
    emptyFileManifest: true,
    deployUrlLogged: false,
    deployUrlRequested: false,
    syntheticOnly: true,
  }

  if (!result.requiredConstantsPresent || process.env.CONTEXT !== 'deploy-preview') {
    console.log(`NETLIFY_UNTRUSTED_REST_DRAFT_PROBE ${JSON.stringify(result)}`)
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

  const createUrl = new URL(`/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, apiHost)
  createUrl.searchParams.set('title', title)
  let createdId = null
  try {
    const created = await requestJson({
      method: 'POST',
      url: createUrl,
      token,
      body: { draft: true, async: false, files: {}, branch },
    })
    createdId = typeof created.body?.id === 'string' && created.body.id.length > 0 ? created.body.id : null
    result.create = {
      status: created.status,
      accepted: created.ok,
      idPresent: createdId !== null,
      returnedExpectedSite: created.body?.site_id === siteId,
      returnedExpectedBranch: created.body?.branch === branch,
      returnedDraft: created.body?.draft === true,
      returnedState:
        typeof created.body?.state === 'string' && created.body.state.length > 0
          ? created.body.state
          : null,
      deployUrlPresent:
        typeof created.body?.deploy_url === 'string' || typeof created.body?.deploy_ssl_url === 'string',
    }

    if (createdId) {
      const readback = await requestJson({
        url: new URL(`/api/v1/deploys/${encodeURIComponent(createdId)}`, apiHost),
        token,
      })
      result.readback = {
        status: readback.status,
        returnedExpectedId: readback.body?.id === createdId,
        returnedExpectedSite: readback.body?.site_id === siteId,
        returnedExpectedBranch: readback.body?.branch === branch,
        returnedDraft: readback.body?.draft === true,
        returnedState:
          typeof readback.body?.state === 'string' && readback.body.state.length > 0
            ? readback.body.state
            : null,
      }
    }
  } finally {
    if (createdId) {
      const removed = await requestJson({
        method: 'DELETE',
        url: new URL(`/api/v1/deploys/${encodeURIComponent(createdId)}`, apiHost),
        token,
      })
      result.cleanup = { attempted: true, status: removed.status, accepted: removed.ok }
      const finalReadback = await requestJson({
        url: new URL(`/api/v1/deploys/${encodeURIComponent(createdId)}`, apiHost),
        token,
      })
      result.finalReadback = {
        status: finalReadback.status,
        absent: finalReadback.status === 404,
      }
    } else {
      result.cleanup = { attempted: false }
    }
  }

  console.log(`NETLIFY_UNTRUSTED_REST_DRAFT_PROBE ${JSON.stringify(result)}`)
}
