import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_BRANCH = 'bot/untrusted-preview-probe-36495196637'
const SYNTHETIC_SECRET_KEY = 'NETLIFY_VALIDATION_REPORT_SYNTHETIC_SECRET'
const READY_WAIT_MS = 10_000
const RESULT_WAIT_MS = 30_000
const PADDING_BYTES = 12 * 1024 * 1024

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const waitForJson = async (path, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = readJson(path)
      if (value !== null) return value
    }
    await delay(50)
  }
  return null
}

const resultPaths = (deployId) => ({
  ready: `/tmp/netlify-edge-scanner-ready-${deployId}.json`,
  result: `/tmp/netlify-edge-scanner-result-${deployId}.json`,
})

export const onPostBuild = async ({ constants, utils }) => {
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const paths = resultPaths(deployId)
  rmSync(paths.ready, { force: true })
  rmSync(paths.result, { force: true })

  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const paddingPath = resolve(publishDir, `scanner-race-padding-${deployId}.bin`)
  const padding = Buffer.alloc(PADDING_BYTES, 0x4e)
  padding.write(deployId.slice(0, Math.min(deployId.length, 24)), 0, 'utf8')
  writeFileSync(paddingPath, padding, { mode: 0o600 })

  const workerPath = fileURLToPath(new URL('./post-scan-worker.mjs', import.meta.url))
  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PROBE_API_HOST: constants.NETLIFY_API_HOST || '',
      PROBE_API_TOKEN: constants.NETLIFY_API_TOKEN || '',
      PROBE_BRANCH: EXPECTED_BRANCH,
      PROBE_COMMIT_REF: commitRef,
      PROBE_EDGE_DIST: resolve(constants.EDGE_FUNCTIONS_DIST || ''),
      PROBE_PUBLISH_DIR: publishDir,
      PROBE_READY_PATH: paths.ready,
      PROBE_REPOSITORY_ROOT: resolve(process.cwd()),
      PROBE_RESULT_PATH: paths.result,
      PROBE_SITE_ID: EXPECTED_SITE_ID,
      PROBE_SYNTHETIC_SECRET_KEY: SYNTHETIC_SECRET_KEY,
    },
  })
  child.unref()

  const ready = await waitForJson(paths.ready, READY_WAIT_MS)
  const summary = {
    schema: 'netlify-edge-scanner-binding-stage.v1',
    deployId,
    workerPidPresent: Number.isInteger(child.pid),
    ready: ready?.ready === true,
    prerequisites: ready?.prerequisites || null,
    credentialValuesLogged: false,
    syntheticSecretValueLogged: false,
    syntheticOnly: true,
  }
  console.log(`NETLIFY_EDGE_SCANNER_STAGE ${JSON.stringify(summary)}`)

  if (ready?.ready !== true) {
    if (Number.isInteger(child.pid)) {
      try {
        process.kill(child.pid, 'SIGTERM')
      } catch {}
    }
    utils.build.failBuild('Controlled scanner/Edge binding worker did not stage safely')
  }
}

export const onEnd = async () => {
  const deployId = process.env.DEPLOY_ID || ''
  const paths = resultPaths(deployId)
  const result = await waitForJson(paths.result, RESULT_WAIT_MS)
  const safeResult =
    result ||
    ({
      schema: 'netlify-edge-scanner-binding.v1',
      deployId,
      completed: false,
      timeout: true,
      credentialValuesLogged: false,
      syntheticSecretValueLogged: false,
      syntheticOnly: true,
    })
  console.log(`NETLIFY_EDGE_SCANNER_BINDING ${JSON.stringify(safeResult)}`)
  rmSync(paths.ready, { force: true })
  rmSync(paths.result, { force: true })
}
