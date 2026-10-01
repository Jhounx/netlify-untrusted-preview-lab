const API_ORIGIN = 'https://api.netlify.com'
const CONTROLLED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const CONTROLLED_PRODUCTION_DEPLOY_ID = '6abb00e9b0fc720008459d80'
const CROSS_SITE_ID = '301d14a0-ba24-4dee-933f-d980b6c4cc17'
const CROSS_SITE_PRODUCTION_DEPLOY_ID = '6abae636e833b3161fac064a'
const BRANCH_PREFIX = 'bot/untrusted-preview-probe-'

const safeApiOrigin = (value) => {
  try {
    const url = new URL(/^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`)
    return (
      url.origin === API_ORIGIN &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

const apiRequest = async (path, token, options = {}) => {
  const response = await fetch(new URL(path, API_ORIGIN), {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  let body = null
  if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
    try {
      body = await response.json()
    } catch {}
  } else {
    await response.body?.cancel()
  }
  return { status: response.status, ok: response.ok, body }
}

const publishedDeployId = (site) =>
  typeof site?.published_deploy?.id === 'string' ? site.published_deploy.id : null

const testNoopRestore = async ({ siteId, deployId, token, ownerSnapshotVerified = false }) => {
  const before = await apiRequest(`/api/v1/sites/${siteId}`, token)
  const beforePublishedDeployId = publishedDeployId(before.body)
  const preflightMatchedExpectedProduction = before.ok && beforePublishedDeployId === deployId
  const safeToAttempt = preflightMatchedExpectedProduction || ownerSnapshotVerified
  if (!safeToAttempt) {
    return {
      preflightStatus: before.status,
      preflightMatchedExpectedProduction: false,
      attempted: false,
      restoreStatus: null,
      postflightStatus: null,
      productionPointerUnchanged: null,
    }
  }

  const restore = await apiRequest(`/api/v1/sites/${siteId}/deploys/${deployId}/restore`, token, {
    method: 'POST',
  })
  const after = await apiRequest(`/api/v1/sites/${siteId}`, token)
  return {
    preflightStatus: before.status,
    preflightMatchedExpectedProduction,
    ownerSnapshotVerified,
    attempted: true,
    restoreStatus: restore.status,
    postflightStatus: after.status,
    productionPointerUnchanged: after.ok && publishedDeployId(after.body) === deployId,
  }
}

export const onPostBuild = async ({ constants, utils }) => {
  const token = constants.NETLIFY_API_TOKEN
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const reviewId = process.env.REVIEW_ID || ''

  let site = null
  let deploy = null
  if (safeApiOrigin(constants.NETLIFY_API_HOST) && typeof token === 'string' && token.length > 0) {
    try {
      ;({ body: site } = await apiRequest(`/api/v1/sites/${CONTROLLED_SITE_ID}`, token))
      ;({ body: deploy } = await apiRequest(`/api/v1/deploys/${deployId}`, token))
    } catch {}
  }

  const branch = typeof deploy?.branch === 'string' ? deploy.branch : ''
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: /^\d+$/.test(reviewId),
    controlledSite: constants.SITE_ID === CONTROLLED_SITE_ID,
    controlledBranch: branch.startsWith(BRANCH_PREFIX),
    buildbotMode: constants.IS_LOCAL === false,
    trustedApiOrigin: safeApiOrigin(constants.NETLIFY_API_HOST),
    untrustedRedactPolicy: site?.build_settings?.untrusted_flow === 'redact',
    publicRepository: site?.build_settings?.public_repo === true,
    deployIdentityBound:
      deploy?.id === deployId &&
      deploy?.site_id === CONTROLLED_SITE_ID &&
      deploy?.context === 'deploy-preview' &&
      String(deploy?.review_id) === reviewId &&
      deploy?.commit_ref === commitRef,
    tokenPresent: typeof token === 'string' && token.length > 0,
  }

  const result = {
    schema: 'netlify-untrusted-restore-authorization-probe.v1',
    prerequisites,
    sameSiteCurrentProduction: null,
    crossSiteCurrentProduction: null,
    credentialValuesLogged: false,
    responseBodiesRetained: false,
    productionContentChangeRequested: false,
    syntheticOnly: true,
  }

  if (!Object.values(prerequisites).every(Boolean)) {
    console.log(`NETLIFY_UNTRUSTED_RESTORE_AUTH ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled restore authorization prerequisites were not satisfied')
    return
  }

  try {
    result.sameSiteCurrentProduction = await testNoopRestore({
      siteId: CONTROLLED_SITE_ID,
      deployId: CONTROLLED_PRODUCTION_DEPLOY_ID,
      token,
    })
    result.crossSiteCurrentProduction = await testNoopRestore({
      siteId: CROSS_SITE_ID,
      deployId: CROSS_SITE_PRODUCTION_DEPLOY_ID,
      token,
      ownerSnapshotVerified: true,
    })
  } catch (error) {
    result.errorClass = error?.name || 'Error'
  }

  console.log(`NETLIFY_UNTRUSTED_RESTORE_AUTH ${JSON.stringify(result)}`)
}
