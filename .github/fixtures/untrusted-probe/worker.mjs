import { readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const required = (name, pattern) => {
  const value = process.env[name] || ''
  if (!pattern.test(value)) throw new Error(`Invalid ${name}`)
  return value
}

const API_ORIGIN = required('RACE_API_ORIGIN', /^https:\/\/api\.netlify\.com$/)
const DEPLOY_ID = required('RACE_DEPLOY_ID', /^[0-9a-f]{24}$/)
const SITE_ID = required('RACE_SITE_ID', /^[0-9a-f-]{36}$/)
const BRANCH = required('RACE_BRANCH', /^bot\/untrusted-preview-probe-[0-9]+$/)
const A_SHA256 = required('RACE_A_SHA256', /^[0-9a-f]{64}$/)
const TOKEN = required('RACE_TOKEN', /^.{20,}$/s)
const TAR_PATH = required(
  'RACE_TAR_PATH',
  /^\/tmp\/netlify-edge-core-race-a-[A-Za-z0-9]+\/edge-core-race-a\.tar\.gz$/,
)
const HANDSHAKE_PATH = required(
  'RACE_HANDSHAKE_PATH',
  /^\/tmp\/netlify-edge-core-race-[0-9a-f]{24}\.json$/,
)

const writeHandshake = (body) => {
  writeFileSync(HANDSHAKE_PATH, JSON.stringify(body), { mode: 0o600 })
}

const existsHandshake = () => {
  try {
    readFileSync(HANDSHAKE_PATH)
    return true
  } catch {
    return false
  }
}

const readDeploy = async () => {
  const response = await fetch(`${API_ORIGIN}/api/v1/deploys/${DEPLOY_ID}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    redirect: 'error',
    signal: AbortSignal.timeout(3_000),
  })
  const body = response.ok ? await response.json() : null
  return {
    ok: response.ok,
    identityMatches:
      body?.id === DEPLOY_ID && body?.site_id === SITE_ID && body?.branch === BRANCH,
    state: typeof body?.state === 'string' ? body.state : null,
    requiredEdge: Array.isArray(body?.required_edge_functions) ? body.required_edge_functions : [],
  }
}

const bytes = readFileSync(TAR_PATH)
const split = Math.max(1, Math.floor(bytes.length / 2))
let uploadRequest
let uploadSettled = false
const uploadResponse = new Promise((resolvePromise, rejectPromise) => {
  const url = new URL(`/api/v1/deploys/${DEPLOY_ID}/edge_functions/${A_SHA256}`, API_ORIGIN)
  uploadRequest = request(
    url,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
      },
    },
    (response) => {
      response.resume()
      response.once('end', () => resolvePromise(response.statusCode || 0))
    },
  )
  uploadRequest.once('error', rejectPromise)
})
uploadResponse.finally(() => {
  uploadSettled = true
}).catch(() => {})

try {
  await new Promise((resolvePromise, rejectPromise) => {
    uploadRequest.once('error', rejectPromise)
    uploadRequest.write(bytes.subarray(0, split), resolvePromise)
  })
  writeHandshake({ firstChunkWritten: true, credentialValuesLogged: false })

  await sleep(250)
  uploadRequest.end(bytes.subarray(split))
  await Promise.race([uploadResponse, sleep(10_000)])
} catch (error) {
  if (!existsHandshake()) {
    try {
      writeHandshake({ firstChunkWritten: false, error: error?.constructor?.name || 'Error' })
    } catch {}
  }
  uploadRequest?.destroy()
  process.exitCode = 1
}
