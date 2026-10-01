import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
const required = (name, pattern) => {
  const value = process.env[name] || ''
  if (!pattern.test(value)) throw new Error(`Invalid ${name}`)
  return value
}

const API_ORIGIN = required('PROBE_API_ORIGIN', /^https:\/\/api\.netlify\.com$/)
const TOKEN = required('PROBE_TOKEN', /^.{20,}$/s)
const SITE_ID = required('PROBE_SITE_ID', /^[0-9a-f-]{36}$/)
const DEPLOY_ID = required('PROBE_DEPLOY_ID', /^[0-9a-f]{24}$/)
const COMMIT_REF = required('PROBE_COMMIT_REF', /^[0-9a-f]{40}$/)
const BRANCH = required('PROBE_BRANCH', /^bot\/untrusted-preview-probe-[0-9]+$/)
const INDEX_SHA1 = required('PROBE_INDEX_SHA1', /^[0-9a-f]{40}$/)
const MARKER_PATH = required('PROBE_MARKER_PATH', /^__post_ready_build_token_probe\.json$/)
const HANDSHAKE_PATH = required(
  'PROBE_HANDSHAKE_PATH',
  /^\/tmp\/netlify-token-after-ready-[0-9a-f]{24}\.json$/,
)

const headers = { authorization: `Bearer ${TOKEN}` }
const getDeploy = async () => {
  const response = await fetch(`${API_ORIGIN}/api/v1/deploys/${DEPLOY_ID}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(3_000),
  })
  const body = response.ok ? await response.json() : null
  return { response, body }
}

writeFileSync(HANDSHAKE_PATH, JSON.stringify({ pollingStarted: true }), { mode: 0o600 })

let readyObservedAt = null
for (let index = 0; index < 500; index += 1) {
  try {
    const { response, body } = await getDeploy()
    const bound =
      response.ok &&
      body?.id === DEPLOY_ID &&
      body?.site_id === SITE_ID &&
      body?.branch === BRANCH &&
      body?.commit_ref === COMMIT_REF
    if (bound && body?.state === 'ready' && Array.isArray(body?.required) && body.required.length === 0) {
      readyObservedAt = new Date().toISOString()
      break
    }
    if (!response.ok && [401, 403, 404].includes(response.status)) process.exit(2)
  } catch {}
  await sleep(25)
}
if (readyObservedAt === null) process.exit(3)

await sleep(300)
const marker = Buffer.from(
  JSON.stringify({
    schema: 'netlify-build-token-after-ready-runtime-oracle.v1',
    nonce: `netlify-token-after-ready-${COMMIT_REF.slice(0, 12)}`,
    readyObservedAt,
    writeAttemptedAt: new Date().toISOString(),
    syntheticOnly: true,
  }),
)
const markerSha1 = createHash('sha1').update(marker).digest('hex')
const update = await fetch(`${API_ORIGIN}/api/v1/sites/${SITE_ID}/deploys/${DEPLOY_ID}`, {
  method: 'PUT',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    files: { 'index.html': INDEX_SHA1, [MARKER_PATH]: markerSha1 },
    functions: {},
    edge_functions: {},
    function_schedules: [],
    functions_config: {},
    async: false,
  }),
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
})
const updated = update.ok ? await update.json() : null
const bound =
  updated?.id === DEPLOY_ID &&
  updated?.site_id === SITE_ID &&
  updated?.branch === BRANCH &&
  updated?.commit_ref === COMMIT_REF
if (!update.ok || !bound || !Array.isArray(updated?.required)) process.exit(4)
if (updated.required.some((digest) => ![INDEX_SHA1, markerSha1].includes(digest))) process.exit(5)

if (updated.required.includes(markerSha1)) {
  const encoded = MARKER_PATH.split('/').map(encodeURIComponent).join('/')
  const url = new URL(`/api/v1/deploys/${DEPLOY_ID}/files/${encoded}`, API_ORIGIN)
  url.searchParams.set('size', String(marker.length))
  const upload = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: marker,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  await upload.body?.cancel()
  if (!upload.ok) process.exit(6)
}

for (let index = 0; index < 200; index += 1) {
  try {
    const { body } = await getDeploy()
    if (body?.state === 'ready' && Array.isArray(body?.required) && body.required.length === 0) process.exit(0)
  } catch {}
  await sleep(25)
}
process.exit(7)
