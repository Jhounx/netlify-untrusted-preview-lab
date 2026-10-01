import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { basename, dirname, relative, resolve } from 'node:path'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_BRANCH = 'bot/untrusted-preview-probe-36495196637'
const EXPECTED_API_ORIGIN = 'https://api.netlify.com'
const EDGE_ROUTE = '/__nf_edge_digest_20261001_v1'
const EDGE_FUNCTION_NAME = 'controlled-edge-canary'
const EDGE_PUBLIC_PREFIX = '.netlify/internal/edge-functions'
const MAX_SOCKET_RESPONSE_BYTES = 8_192
const EXPECTED_INDEX_SHA256 = '082c212e8f7647d12f451edc3e6c7d152bf0fd5bd1bb372fcb897b9c04f781fe'

const A_SOURCE = `const NONCE = 'netlify-edge-digest-untrusted-declared-a-20261001-v1'

export default async () =>
  Response.json(
    {
      schema: 'netlify-edge-digest-untrusted-runtime-oracle.v1',
      nonce: NONCE,
      variant: 'declared-a',
      syntheticOnly: true,
    },
    {
      headers: {
        'cache-control': 'no-store',
        'x-netlify-controlled-probe': NONCE,
      },
    },
  )

export const config = {
  path: '${EDGE_ROUTE}',
}
`

const B_SOURCE = A_SOURCE.replace(
  "netlify-edge-digest-untrusted-declared-a-20261001-v1",
  "netlify-edge-digest-untrusted-uploaded-b-20261001-v1",
).replace("variant: 'declared-a'", "variant: 'uploaded-b'")

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const normalizeApiBase = (value) =>
  /^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`

const safeState = (value) =>
  [
    'new',
    'enqueued',
    'building',
    'uploading',
    'uploaded',
    'preparing',
    'prepared',
    'processing',
    'processed',
    'ready',
    'error',
  ].includes(value)
    ? value
    : null

const readSitePolicy = async ({ apiBase, token }) => {
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
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

const readDeploy = async ({ apiBase, commitRef, deployId, token }) => {
  try {
    const response = await fetch(new URL(`/api/v1/deploys/${deployId}`, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    return {
      status: response.status,
      deployIdMatches: body?.id === deployId,
      siteIdMatches: body?.site_id === EXPECTED_SITE_ID,
      contextMatches: body?.context === 'deploy-preview',
      branchMatches: body?.branch === EXPECTED_BRANCH,
      reviewIdMatches: String(body?.review_id) === '1',
      commitRefMatches: body?.commit_ref === commitRef,
      state: safeState(body?.state),
      pluginState: typeof body?.plugin_state === 'string' ? body.plugin_state : null,
      published: body?.published_at != null,
      edgeFunctionsPresent: body?.edge_functions_present === true,
      requiredEdgeCount: Array.isArray(body?.required_edge_functions)
        ? body.required_edge_functions.length
        : null,
      responseBodyRetained: false,
    }
  } catch (error) {
    return {
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
      responseBodyRetained: false,
    }
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
    if (!socketPath) {
      resolveRequest(result)
      return
    }

    const responseChunks = []
    let responseBytes = 0
    let settled = false
    const client = createConnection({ path: socketPath })
    const finish = (parsed) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.destroy()
      result.responseWasJson = parsed !== undefined
      result.responseSucceeded = parsed?.succeeded === true
      result.responseErrorType = ['none', 'user', 'internal'].includes(parsed?.values?.error_type)
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
      responseBytes += chunk.length
      if (responseBytes > MAX_SOCKET_RESPONSE_BYTES) {
        result.responseTooLarge = true
        finish()
        return
      }
      responseChunks.push(chunk)
      try {
        finish(JSON.parse(Buffer.concat(responseChunks, responseBytes).toString('utf8')))
      } catch {}
    })
    client.once('error', finish)
    client.once('end', () => finish())
  })

const makeTarBundle = ({ repositoryRoot, source, variant }) => {
  const root = mkdtempSync(resolve(repositoryRoot, `.netlify-edge-digest-${variant}-`))
  const input = resolve(root, 'input')
  const archive = resolve(root, `${variant}.tar.gz`)
  mkdirSync(input)
  const route = {
    function: EDGE_FUNCTION_NAME,
    pattern: '^/__nf_edge_digest_20261001_v1/?$',
    excluded_patterns: [],
    path: EDGE_ROUTE,
  }
  writeFileSync(
    resolve(input, '___netlify-edge-functions.json'),
    JSON.stringify({
      functions: { [EDGE_FUNCTION_NAME]: `${EDGE_FUNCTION_NAME}.js` },
      version: 2,
      function_config: {},
      routes: [route],
      post_cache_routes: [],
    }),
  )
  writeFileSync(resolve(input, 'deno.json'), JSON.stringify({ imports: {}, scopes: {} }))
  writeFileSync(resolve(input, `${EDGE_FUNCTION_NAME}.js`), source)
  const tar = spawnSync('tar', ['-czf', archive, '-C', input, '.'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    timeout: 20_000,
  })
  if (tar.status !== 0 || !existsSync(archive)) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('Synthetic Edge tar creation failed')
  }
  const bytes = readFileSync(archive)
  return { bytes, root, sha1: hash('sha1', bytes), sha256: hash('sha256', bytes) }
}

const loadArtifacts = ({ edgeDist, repositoryRoot }) => {
  const edgeDistStats = lstatSync(edgeDist)
  const edgeDistReal = realpathSync(edgeDist)
  if (!edgeDistStats.isDirectory() || edgeDistStats.isSymbolicLink()) {
    throw new Error('Unexpected Edge dist directory')
  }
  const manifestPath = resolve(edgeDistReal, 'manifest.json')
  const originalManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const eszipDescriptors = (originalManifest.bundles || []).filter(
    (bundle) => bundle?.format === 'eszip2' && /^[0-9a-f]{64}\.eszip$/.test(bundle?.asset || ''),
  )
  if (eszipDescriptors.length !== 1) throw new Error('Expected exactly one ESZIP2 bundle')
  const eszipDescriptor = eszipDescriptors[0]
  const eszipPath = resolve(edgeDistReal, eszipDescriptor.asset)
  if (dirname(eszipPath) !== edgeDistReal) throw new Error('Unexpected ESZIP2 path')
  const eszipBytes = readFileSync(eszipPath)
  const eszipSha256 = hash('sha256', eszipBytes)
  if (basename(eszipDescriptor.asset, '.eszip') !== eszipSha256) {
    throw new Error('ESZIP2 filename digest mismatch')
  }
  const routes = Array.isArray(originalManifest.routes) ? originalManifest.routes : []
  if (
    routes.length !== 1 ||
    routes[0]?.function !== EDGE_FUNCTION_NAME ||
    routes[0]?.path !== EDGE_ROUTE ||
    routes[0]?.pattern !== '^/__nf_edge_digest_20261001_v1/?$'
  ) {
    throw new Error('Unexpected Edge manifest routes')
  }

  const declared = makeTarBundle({ repositoryRoot, source: A_SOURCE, variant: 'declared-a' })
  const uploaded = makeTarBundle({ repositoryRoot, source: B_SOURCE, variant: 'uploaded-b' })
  if (declared.sha256 === uploaded.sha256 || declared.bytes.equals(uploaded.bytes)) {
    throw new Error('Synthetic Edge variants are not distinct')
  }

  const manifest = {
    ...originalManifest,
    bundles: [
      {
        asset: `${declared.sha256}.tar.gz`,
        format: 'tar',
        custom_import_map: false,
        vendor_manifest: false,
      },
      eszipDescriptor,
    ],
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  return {
    cleanupRoots: [declared.root, uploaded.root],
    declared,
    uploaded,
    eszip: {
      asset: eszipDescriptor.asset,
      bytes: eszipBytes,
      sha1: hash('sha1', eszipBytes),
      sha256: eszipSha256,
    },
    manifest: {
      bytes: manifestBytes,
      sha1: hash('sha1', manifestBytes),
      sha256: hash('sha256', manifestBytes),
    },
  }
}

const declareDeploy = async ({ apiBase, body, commitRef, deployId, knownHashes, token }) => {
  try {
    const response = await fetch(
      new URL(`/api/v1/sites/${EXPECTED_SITE_ID}/deploys/${deployId}`, apiBase),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      },
    )
    const responseBody = response.ok ? await response.json() : null
    const requiredFiles = Array.isArray(responseBody?.required) ? responseBody.required : []
    const requiredEdgeFunctions = Array.isArray(responseBody?.required_edge_functions)
      ? responseBody.required_edge_functions
      : []
    const identityMatches =
      responseBody?.id === deployId &&
      responseBody?.site_id === EXPECTED_SITE_ID &&
      responseBody?.context === 'deploy-preview' &&
      responseBody?.branch === EXPECTED_BRANCH &&
      String(responseBody?.review_id) === '1' &&
      responseBody?.commit_ref === commitRef
    const requirementsValid =
      response.ok &&
      Array.isArray(responseBody?.required) &&
      Array.isArray(responseBody?.required_edge_functions) &&
      requiredFiles.every((value) => knownHashes.files.has(value)) &&
      requiredEdgeFunctions.every((value) => knownHashes.edge.has(value)) &&
      new Set(requiredFiles).size === requiredFiles.length &&
      new Set(requiredEdgeFunctions).size === requiredEdgeFunctions.length
    return {
      evidence: {
        status: response.status,
        ok: response.ok,
        identityMatches,
        requirementsValid,
        requiredFileCount: requiredFiles.length,
        requiredEdgeCount: requiredEdgeFunctions.length,
        responseBodyRetained: false,
      },
      requiredFiles,
      requiredEdgeFunctions,
      safeToUpload: identityMatches && requirementsValid,
    }
  } catch (error) {
    return {
      evidence: {
        requestFailed: true,
        errorClass: error?.constructor?.name || 'Error',
        responseBodyRetained: false,
      },
      requiredFiles: [],
      requiredEdgeFunctions: [],
      safeToUpload: false,
    }
  }
}

const uploadStaticFile = async ({ apiBase, deployId, record, token }) => {
  try {
    const encodedPath = record.path.split('/').map(encodeURIComponent).join('/')
    const url = new URL(`/api/v1/deploys/${deployId}/files/${encodedPath}`, apiBase)
    url.searchParams.set('size', String(record.bytes.length))
    const response = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: record.bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    await response.body?.cancel()
    return { status: response.status, ok: response.ok, responseBodyRead: false }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

const uploadMismatchedEdgeBundle = async ({ apiBase, declaredSha, deployId, uploadedBytes, token }) => {
  try {
    const url = new URL(`/api/v1/deploys/${deployId}/edge_functions/${declaredSha}`, apiBase)
    const response = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: uploadedBytes,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    await response.body?.cancel()
    return { status: response.status, ok: response.ok, responseBodyRead: false }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

const requestPinnedEarlyDeploy = async ({ records, repositoryRoot }) => {
  const output = { snapshot: { created: false, validated: false, removed: false }, deploy: null }
  let snapshotRoot = null
  try {
    snapshotRoot = mkdtempSync(resolve(repositoryRoot, '.netlify-edge-digest-snapshot-'))
    const snapshotRelative = relative(repositoryRoot, snapshotRoot)
    if (!/^\.netlify-edge-digest-snapshot-[A-Za-z0-9]+$/.test(snapshotRelative)) {
      throw new Error('Unexpected snapshot path')
    }
    output.snapshot.created = true
    for (const record of records) {
      const destination = resolve(snapshotRoot, record.path)
      if (relative(snapshotRoot, destination).startsWith('..')) throw new Error('Snapshot path escaped')
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, record.bytes)
    }
    output.snapshot.validated = records.every((record) => {
      const destination = resolve(snapshotRoot, record.path)
      return hash('sha256', readFileSync(destination)) === hash('sha256', record.bytes)
    })
    if (!output.snapshot.validated) throw new Error('Snapshot validation failed')
    output.deploy = await requestEarlyDeploy(snapshotRelative)
  } catch (error) {
    output.snapshot.errorClass = error?.constructor?.name || 'Error'
  } finally {
    if (snapshotRoot !== null) {
      const snapshotRelative = relative(repositoryRoot, snapshotRoot)
      if (/^\.netlify-edge-digest-snapshot-[A-Za-z0-9]+$/.test(snapshotRelative)) {
        rmSync(snapshotRoot, { recursive: true, force: true })
        output.snapshot.removed = !existsSync(snapshotRoot)
      }
    }
  }
  return output
}

export const onPostBuild = async ({ constants, utils }) => {
  const repositoryRoot = resolve(process.cwd())
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const edgeDist = resolve(constants.EDGE_FUNCTIONS_DIST || '')
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const token = constants.NETLIFY_API_TOKEN
  const apiBase = normalizeApiBase(constants.NETLIFY_API_HOST)
  let apiEndpointTrusted = false
  try {
    const parsed = new URL(apiBase)
    apiEndpointTrusted =
      parsed.origin === EXPECTED_API_ORIGIN &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.username === '' &&
      parsed.password === ''
  } catch {}

  const policy =
    apiEndpointTrusted && typeof token === 'string' && token.length > 0
      ? await readSitePolicy({ apiBase, token })
      : null
  const before =
    apiEndpointTrusted &&
    typeof token === 'string' &&
    token.length > 0 &&
    /^[0-9a-f]{24}$/.test(deployId) &&
    /^[0-9a-f]{40}$/.test(commitRef)
      ? await readDeploy({ apiBase, commitRef, deployId, token })
      : null

  let artifacts = null
  let artifactError = null
  try {
    const sourcePath = resolve(repositoryRoot, 'netlify/edge-functions/controlled-edge-canary.js')
    if (readFileSync(sourcePath, 'utf8') !== A_SOURCE) throw new Error('Controlled source mismatch')
    artifacts = loadArtifacts({ edgeDist, repositoryRoot })
  } catch (error) {
    artifactError = error?.constructor?.name || 'Error'
  }

  let publicRecord = null
  let publicError = null
  try {
    const rootReal = realpathSync(repositoryRoot)
    const publishStats = lstatSync(publishDir)
    const publishReal = realpathSync(publishDir)
    if (
      !publishStats.isDirectory() ||
      publishStats.isSymbolicLink() ||
      relative(rootReal, publishReal) !== 'public'
    ) {
      throw new Error('Unexpected publish directory')
    }
    const indexBytes = readFileSync(resolve(publishReal, 'index.html'))
    if (hash('sha256', indexBytes) !== EXPECTED_INDEX_SHA256) throw new Error('Unexpected index file')
    publicRecord = { path: 'index.html', bytes: indexBytes, sha1: hash('sha1', indexBytes) }
  } catch (error) {
    publicError = error?.constructor?.name || 'Error'
  }

  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: process.env.REVIEW_ID === '1',
    controlledSite: constants.SITE_ID === EXPECTED_SITE_ID,
    buildbotMode: constants.IS_LOCAL === false,
    trustedApiEndpoint: apiEndpointTrusted,
    policyReadSucceeded: policy?.status === 200,
    redactedPolicy: policy?.untrustedFlow === 'redact',
    publicRepository: policy?.publicRepo === true,
    currentDeployBound:
      before?.status === 200 &&
      before?.deployIdMatches === true &&
      before?.siteIdMatches === true &&
      before?.contextMatches === true &&
      before?.branchMatches === true &&
      before?.reviewIdMatches === true &&
      before?.commitRefMatches === true &&
      before?.state === 'building' &&
      before?.published === false,
    tokenPresent: typeof token === 'string' && token.length > 0,
    artifactsValid: artifacts !== null && artifactError === null,
    publicFixtureValid: publicRecord !== null && publicError === null,
  }

  const result = {
    schema: 'netlify-untrusted-edge-digest-substitution.v1',
    prerequisites,
    policy,
    before,
    artifacts:
      artifacts === null
        ? { valid: false, errorClass: artifactError }
        : {
            valid: true,
            declaredTarBytes: artifacts.declared.bytes.length,
            uploadedTarBytes: artifacts.uploaded.bytes.length,
            declaredTarSha256: artifacts.declared.sha256,
            uploadedTarSha256: artifacts.uploaded.sha256,
            bytesEqual: artifacts.declared.bytes.equals(artifacts.uploaded.bytes),
            eszipSha256: artifacts.eszip.sha256,
            manifestSha256: artifacts.manifest.sha256,
          },
    attempted: false,
    declare: null,
    uploads: null,
    snapshot: null,
    deploy: null,
    after: null,
    controlledFailureRequested: false,
    credentialValuesLogged: false,
    responseBodiesRetained: false,
    syntheticOnly: true,
  }

  try {
    if (!Object.values(prerequisites).every(Boolean)) {
      console.log(`NETLIFY_UNTRUSTED_EDGE_DIGEST ${JSON.stringify(result)}`)
      utils.build.failBuild('Controlled Edge digest prerequisites were not satisfied')
      return
    }

    result.attempted = true
    const records = [
      publicRecord,
      {
        path: `${EDGE_PUBLIC_PREFIX}/manifest.json`,
        bytes: artifacts.manifest.bytes,
        sha1: artifacts.manifest.sha1,
      },
      {
        path: `${EDGE_PUBLIC_PREFIX}/${artifacts.declared.sha256}.tar.gz`,
        bytes: artifacts.declared.bytes,
        sha1: artifacts.declared.sha1,
      },
      {
        path: `${EDGE_PUBLIC_PREFIX}/${artifacts.eszip.asset}`,
        bytes: artifacts.eszip.bytes,
        sha1: artifacts.eszip.sha1,
      },
    ]
    const files = Object.fromEntries(records.map((record) => [record.path, record.sha1]))
    const knownHashes = {
      files: new Set(records.map((record) => record.sha1)),
      edge: new Set([artifacts.declared.sha256]),
    }
    const declaration = await declareDeploy({
      apiBase,
      body: {
        files,
        functions: {},
        edge_functions: { tar: artifacts.declared.sha256, eszip2: artifacts.eszip.sha256 },
        function_schedules: [],
        functions_config: {},
        async: false,
      },
      commitRef,
      deployId,
      knownHashes,
      token,
    })
    result.declare = declaration.evidence

    if (declaration.safeToUpload) {
      const recordsByHash = new Map(records.map((record) => [record.sha1, record]))
      const staticUploads = []
      for (const requiredHash of declaration.requiredFiles) {
        const record = recordsByHash.get(requiredHash)
        if (record) staticUploads.push(await uploadStaticFile({ apiBase, deployId, record, token }))
      }
      let edgeUpload = { required: false, ok: true, status: null }
      if (declaration.requiredEdgeFunctions.includes(artifacts.declared.sha256)) {
        edgeUpload = {
          required: true,
          ...(await uploadMismatchedEdgeBundle({
            apiBase,
            declaredSha: artifacts.declared.sha256,
            deployId,
            uploadedBytes: artifacts.uploaded.bytes,
            token,
          })),
        }
      }
      result.uploads = {
        staticUploadCount: staticUploads.length,
        staticUploadsAllSucceeded: staticUploads.every((upload) => upload.ok === true),
        edgeUpload,
        digestMismatchSent: artifacts.declared.sha256 !== artifacts.uploaded.sha256,
      }

      if (result.uploads.staticUploadsAllSucceeded && edgeUpload.ok === true) {
        const early = await requestPinnedEarlyDeploy({ records, repositoryRoot })
        result.snapshot = early.snapshot
        result.deploy = early.deploy
        result.after = await readDeploy({ apiBase, commitRef, deployId, token })
      }
    }
  } finally {
    for (const cleanupRoot of artifacts?.cleanupRoots || []) {
      const cleanupRelative = relative(repositoryRoot, cleanupRoot)
      if (/^\.netlify-edge-digest-(?:declared-a|uploaded-b)-[A-Za-z0-9]+$/.test(cleanupRelative)) {
        rmSync(cleanupRoot, { recursive: true, force: true })
      }
    }
  }

  result.controlledFailureRequested = true
  console.log(`NETLIFY_UNTRUSTED_EDGE_DIGEST ${JSON.stringify(result)}`)
  utils.build.failBuild('Controlled failure after Edge digest substitution probe')
}
