import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const WATCH_MODE = '--watch-bundled-function'

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

const countFunctionBundles = (functionsDist) => {
  try {
    return readdirSync(functionsDist, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.zip'),
    ).length
  } catch {
    return 0
  }
}

const runWatcher = async ({ deployDir, functionsDist, publishDir }) => {
  const startedAt = Date.now()
  let bundleCount = 0

  while (Date.now() - startedAt < 120_000) {
    bundleCount = countFunctionBundles(functionsDist)
    if (bundleCount > 0) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 2))
  }

  const result = {
    schema: 'netlify-post-bundle-function-preemption-watcher.v1',
    functionBundleObserved: bundleCount > 0,
    functionBundleCount: bundleCount,
    credentialValuesLogged: false,
    syntheticOnly: true,
  }

  if (result.functionBundleObserved) {
    try {
      writeFileSync(
        resolve(publishDir, 'post-bundle-watcher.json'),
        `${JSON.stringify({ ...result, deployRequested: true })}\n`,
        { mode: 0o600 },
      )
      result.markerWrittenBeforeDeploy = true
    } catch {
      result.markerWrittenBeforeDeploy = false
    }
    result.deploy = await requestEarlyDeploy(deployDir)
  }

  console.log(`NETLIFY_POST_BUNDLE_FUNCTION_WATCHER ${JSON.stringify(result)}`)
}

const readPolicy = async ({ token, apiHost }) => {
  try {
    const base = /^https?:\/\//i.test(apiHost || '') ? apiHost : `https://${apiHost || 'api.netlify.com'}`
    const response = await fetch(new URL(`/api/v1/sites/${EXPECTED_SITE_ID}`, base), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    return { status: response.status, untrustedFlow: body?.build_settings?.untrusted_flow || null }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

if (process.argv[2] === WATCH_MODE) {
  await runWatcher({
    functionsDist: process.argv[3],
    deployDir: process.argv[4],
    publishDir: process.argv[5],
  })
  process.exit(0)
}

export const onPostBuild = async ({ constants }) => {
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const repositoryRoot = resolve(process.cwd())
  const functionsDist = resolve(constants.FUNCTIONS_DIST || '')
  const deployDir = relative(repositoryRoot, publishDir) || '.'
  const publishInsideRepository = !isAbsolute(deployDir) && !deployDir.startsWith('..')
  const policy =
    typeof constants.NETLIFY_API_TOKEN === 'string' && constants.NETLIFY_API_TOKEN.length > 0
      ? await readPolicy({ token: constants.NETLIFY_API_TOKEN, apiHost: constants.NETLIFY_API_HOST })
      : null
  const functionBundleCountAtPluginTime = countFunctionBundles(functionsDist)
  const prerequisitesSatisfied =
    process.env.CONTEXT === 'deploy-preview' &&
    process.env.REVIEW_ID === '1' &&
    constants.SITE_ID === EXPECTED_SITE_ID &&
    policy?.untrustedFlow === 'redact' &&
    publishInsideRepository &&
    isAbsolute(functionsDist) &&
    existsSync(publishDir) &&
    functionBundleCountAtPluginTime === 0

  const result = {
    schema: 'netlify-post-bundle-function-preemption.v1',
    contextIsDeployPreview: process.env.CONTEXT === 'deploy-preview',
    reviewIdIsOne: process.env.REVIEW_ID === '1',
    siteIdMatches: constants.SITE_ID === EXPECTED_SITE_ID,
    policy,
    publishInsideRepository,
    functionsDistIsAbsolute: isAbsolute(functionsDist),
    noFunctionBundlePresentAtPluginTime: functionBundleCountAtPluginTime === 0,
    prerequisitesSatisfied,
    watcherSpawned: false,
    credentialValuesLogged: false,
    syntheticOnly: true,
  }

  if (prerequisitesSatisfied) {
    const watcher = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), WATCH_MODE, functionsDist, deployDir, publishDir],
      {
        cwd: repositoryRoot,
        detached: true,
        env: {},
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )
    watcher.unref()
    result.watcherSpawned = true
  }

  console.log(`NETLIFY_POST_BUNDLE_FUNCTION_PREEMPTION ${JSON.stringify(result)}`)
}
