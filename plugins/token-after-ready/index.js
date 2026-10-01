import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const API_ORIGIN = 'https://api.netlify.com'
const BRANCH_PREFIX = 'bot/untrusted-preview-probe-'
const MARKER_PATH = '__post_ready_build_token_probe.json'
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')

const safeApiOrigin = (value) => {
  try {
    const url = new URL(/^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`)
    return url.origin === API_ORIGIN && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
  } catch {
    return false
  }
}

const apiGet = async (path, token) => {
  const response = await fetch(new URL(path, API_ORIGIN), {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const body = response.ok ? await response.json() : null
  return { response, body }
}

const waitHandshake = async (path) => {
  for (let index = 0; index < 100; index += 1) {
    try {
      const body = JSON.parse(readFileSync(path, 'utf8'))
      if (body?.pollingStarted === true || body?.error) return body
    } catch {}
    await sleep(50)
  }
  return null
}

export const onPostBuild = async ({ constants, utils }) => {
  const root = resolve(process.cwd())
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const reviewId = process.env.REVIEW_ID || ''
  const token = constants.NETLIFY_API_TOKEN
  let site = null
  let deploy = null
  try {
    if (safeApiOrigin(constants.NETLIFY_API_HOST) && typeof token === 'string' && token.length > 0) {
      ;({ body: site } = await apiGet(`/api/v1/sites/${SITE_ID}`, token))
      ;({ body: deploy } = await apiGet(`/api/v1/deploys/${deployId}`, token))
    }
  } catch {}
  const indexPath = resolve(publishDir, 'index.html')
  let indexBytes = null
  try {
    const stats = lstatSync(indexPath)
    if (stats.isFile() && !stats.isSymbolicLink()) indexBytes = readFileSync(indexPath)
  } catch {}
  const branch = typeof deploy?.branch === 'string' ? deploy.branch : ''
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: /^\d+$/.test(reviewId),
    controlledSite: constants.SITE_ID === SITE_ID,
    controlledBranch: branch.startsWith(BRANCH_PREFIX),
    buildbotMode: constants.IS_LOCAL === false,
    trustedApiOrigin: safeApiOrigin(constants.NETLIFY_API_HOST),
    untrustedRedactPolicy: site?.build_settings?.untrusted_flow === 'redact',
    publicRepository: site?.build_settings?.public_repo === true,
    deployIdentityBound:
      deploy?.id === deployId &&
      deploy?.site_id === SITE_ID &&
      deploy?.context === 'deploy-preview' &&
      String(deploy?.review_id) === reviewId &&
      deploy?.commit_ref === commitRef,
    tokenPresent: typeof token === 'string' && token.length > 0,
    publishDirectoryExpected: relative(root, publishDir) === 'public',
    indexFileControlled: indexBytes !== null,
  }
  const result = {
    schema: 'netlify-build-token-after-ready-probe.v1',
    prerequisites,
    attempted: false,
    workerDetached: false,
    pollingStarted: false,
    markerPath: MARKER_PATH,
    credentialValuesLogged: false,
    responseBodiesRetained: false,
    syntheticOnly: true,
  }
  if (!Object.values(prerequisites).every(Boolean)) {
    console.log(`NETLIFY_TOKEN_AFTER_READY ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled token-after-ready prerequisites were not satisfied')
    return
  }

  const workerPath = resolve(root, 'plugins/token-after-ready/worker.mjs')
  const workerStats = lstatSync(workerPath)
  if (!workerStats.isFile() || workerStats.isSymbolicLink()) {
    utils.build.failBuild('Controlled token-after-ready worker was invalid')
    return
  }
  const handshakePath = join(tmpdir(), `netlify-token-after-ready-${deployId}.json`)
  rmSync(handshakePath, { force: true })
  result.attempted = true
  const worker = spawn(process.execPath, [workerPath], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: {
      PROBE_API_ORIGIN: API_ORIGIN,
      PROBE_TOKEN: token,
      PROBE_SITE_ID: SITE_ID,
      PROBE_DEPLOY_ID: deployId,
      PROBE_COMMIT_REF: commitRef,
      PROBE_BRANCH: branch,
      PROBE_INDEX_SHA1: sha1(indexBytes),
      PROBE_MARKER_PATH: MARKER_PATH,
      PROBE_HANDSHAKE_PATH: handshakePath,
    },
  })
  worker.unref()
  result.workerDetached = true
  const handshake = await waitHandshake(handshakePath)
  rmSync(handshakePath, { force: true })
  result.pollingStarted = handshake?.pollingStarted === true
  if (!result.pollingStarted) {
    try {
      worker.kill('SIGTERM')
    } catch {}
    result.error = handshake?.error || 'worker-handshake-timeout'
    console.log(`NETLIFY_TOKEN_AFTER_READY ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled token-after-ready worker did not start')
    return
  }
  console.log(`NETLIFY_TOKEN_AFTER_READY ${JSON.stringify(result)}`)
}
