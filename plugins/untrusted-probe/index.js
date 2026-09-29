import { createHash } from 'node:crypto'
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
import { createConnection } from 'node:net'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_BRANCH = 'bot/untrusted-preview-probe-36495196637'
const EXPECTED_API_ORIGIN = 'https://api.netlify.com'
const EDGE_ROUTE = '/__nf_edge_finalization_20260929'
const EDGE_FUNCTION_NAME = 'controlled-edge-canary'
const EDGE_PUBLIC_PREFIX = '.netlify/internal/edge-functions'
const MAX_PUBLIC_FILES = 20
const MAX_SOCKET_RESPONSE_BYTES = 8_192
const EXPECTED_EDGE_BUNDLE_SHA256 =
  'f873c0cfca33a9fb47b212ba60689b18a0983ad4b568e4399ff87292cb549a28'
const EXPECTED_EDGE_MANIFEST_SHA256 =
  '36627733ae24c25b91de14e99aebdbec2e22efbf27da19c7a32efa93f4b8f4cf'
const EXPECTED_EDGE_BUNDLE_BYTES = 3_449
const EXPECTED_EDGE_MANIFEST_BYTES = 394
const EXPECTED_PUBLIC_FILES = new Map([
  ['index.html', '082c212e8f7647d12f451edc3e6c7d152bf0fd5bd1bb372fcb897b9c04f781fe'],
])

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')

const normalizeApiBase = (value) =>
  /^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`

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

const readCurrentDeploy = async ({ apiBase, commitRef, deployId, token }) => {
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
      draftStatusMatches: body?.draft == null,
      preMutationState: body?.state === 'building',
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
    client.once('close', finish)
  })

const collectFiles = (root, prefix = '') => {
  const records = []

  const visit = (directory, relativeDirectory = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = resolve(directory, entry.name)
      const stats = lstatSync(absolutePath)

      if (stats.isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed in the controlled deploy input')
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath)
        continue
      }
      const safePath =
        /^[A-Za-z0-9._/-]+$/.test(relativePath) &&
        !relativePath.startsWith('/') &&
        !relativePath.includes('//') &&
        relativePath.split('/').every((segment) => segment !== '.' && segment !== '..')
      if (!entry.isFile() || !safePath) {
        throw new Error('Unexpected deploy input entry')
      }

      const bytes = readFileSync(absolutePath)
      records.push({
        absolutePath,
        bytes,
        normalizedPath: prefix ? `${prefix}/${relativePath}` : relativePath,
        sha1: hash('sha1', bytes),
        sha256: hash('sha256', bytes),
      })
    }
  }

  visit(root)
  return records
}

const requestPinnedEarlyDeploy = async ({ fileRecords, repositoryRoot }) => {
  const output = {
    snapshot: {
      created: false,
      validated: false,
      removed: false,
    },
    deploy: null,
  }
  let snapshotRoot = null

  try {
    snapshotRoot = mkdtempSync(resolve(repositoryRoot, '.netlify-controlled-edge-finalize-'))
    const snapshotRelative = relative(repositoryRoot, snapshotRoot)
    if (
      !/^\.netlify-controlled-edge-finalize-[A-Za-z0-9]+$/.test(snapshotRelative) ||
      snapshotRelative.includes('/')
    ) {
      throw new Error('Unexpected snapshot path')
    }
    output.snapshot.created = true

    for (const record of fileRecords) {
      const destination = resolve(snapshotRoot, record.normalizedPath)
      const destinationRelative = relative(snapshotRoot, destination)
      if (destinationRelative.startsWith('..') || destinationRelative === '') {
        throw new Error('Snapshot file escaped the controlled root')
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      writeFileSync(destination, record.bytes, { flag: 'wx', mode: 0o600 })
    }

    const expectedInventory = fileRecords
      .map(({ bytes, normalizedPath, sha1 }) => ({ bytes: bytes.length, normalizedPath, sha1 }))
      .sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath))
    const actualInventory = collectFiles(snapshotRoot)
      .map(({ bytes, normalizedPath, sha1 }) => ({ bytes: bytes.length, normalizedPath, sha1 }))
      .sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath))
    output.snapshot.validated =
      JSON.stringify(actualInventory) === JSON.stringify(expectedInventory)
    if (!output.snapshot.validated) {
      throw new Error('Pinned deploy snapshot validation failed')
    }

    output.deploy = await requestEarlyDeploy(snapshotRelative)
  } catch (error) {
    output.snapshot.errorClass = error?.constructor?.name || 'Error'
  } finally {
    if (snapshotRoot !== null) {
      const snapshotRelative = relative(repositoryRoot, snapshotRoot)
      if (/^\.netlify-controlled-edge-finalize-[A-Za-z0-9]+$/.test(snapshotRelative)) {
        rmSync(snapshotRoot, { recursive: true, force: true })
        output.snapshot.removed = !existsSync(snapshotRoot)
      }
    }
  }

  return output
}

const loadEdgeArtifact = (edgeFunctionsDist, repositoryRoot, isLocal) => {
  try {
    if (typeof edgeFunctionsDist !== 'string' || edgeFunctionsDist.length === 0) {
      return { evidence: { valid: false, reason: 'dist-path-missing' } }
    }
    const dist = resolve(edgeFunctionsDist || '')
    const distStats = lstatSync(dist)
    const distReal = realpathSync(dist)
    let distLocationTrusted = false
    if (isLocal === false) {
      const tempRootReal = realpathSync('/tmp')
      const tempRelative = relative(tempRootReal, distReal)
      distLocationTrusted =
        isAbsolute(edgeFunctionsDist) &&
        tempRelative !== '' &&
        !tempRelative.startsWith('..') &&
        !isAbsolute(tempRelative)
    } else {
      const expectedDistReal = realpathSync(resolve(repositoryRoot, '.netlify/edge-functions-dist'))
      distLocationTrusted = distReal === expectedDistReal
    }
    if (
      !distStats.isDirectory() ||
      distStats.isSymbolicLink() ||
      !distLocationTrusted
    ) {
      return { evidence: { valid: false, reason: 'dist-not-regular-directory' } }
    }

    const entries = readdirSync(dist, { withFileTypes: true })
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      return { evidence: { valid: false, reason: 'unexpected-dist-entry-type' } }
    }

    const names = entries.map((entry) => entry.name).sort()
    const expectedAssetName = `${EXPECTED_EDGE_BUNDLE_SHA256}.eszip`
    const expectedNames = [expectedAssetName, 'manifest.json'].sort()
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      return {
        evidence: {
          valid: false,
          reason: 'unexpected-dist-file-set',
          distFileCount: names.length,
        },
      }
    }

    const manifestPath = resolve(dist, 'manifest.json')
    const bundlePath = resolve(dist, expectedAssetName)
    const manifestStats = lstatSync(manifestPath)
    const bundleStats = lstatSync(bundlePath)
    if (
      !manifestStats.isFile() ||
      manifestStats.isSymbolicLink() ||
      manifestStats.size !== EXPECTED_EDGE_MANIFEST_BYTES ||
      !bundleStats.isFile() ||
      bundleStats.isSymbolicLink() ||
      bundleStats.size !== EXPECTED_EDGE_BUNDLE_BYTES
    ) {
      return { evidence: { valid: false, reason: 'artifact-size-or-type-mismatch' } }
    }

    const manifestBytes = readFileSync(manifestPath)
    const bundleBytes = readFileSync(bundlePath)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const bundles = Array.isArray(manifest?.bundles) ? manifest.bundles : []
    const routes = Array.isArray(manifest?.routes) ? manifest.routes : []
    const bundle = bundles.length === 1 ? bundles[0] : null
    const route = routes.length === 1 ? routes[0] : null
    const assetName = typeof bundle?.asset === 'string' ? bundle.asset : ''
    const assetNameSafe = /^[0-9a-f]{64}\.eszip$/.test(assetName)
    const codeSha = hash('sha256', bundleBytes)
    const manifestSha = hash('sha256', manifestBytes)
    const exactManifestShape =
      JSON.stringify(Object.keys(manifest).sort()) ===
        JSON.stringify(
          [
            'bundler_version',
            'bundles',
            'function_config',
            'import_map',
            'layers',
            'post_cache_routes',
            'routes',
          ].sort(),
        ) &&
      manifest.bundler_version === '16.1.1' &&
      JSON.stringify(Object.keys(bundle || {}).sort()) === JSON.stringify(['asset', 'format']) &&
      JSON.stringify(Object.keys(route || {}).sort()) ===
        JSON.stringify(['excluded_patterns', 'function', 'path', 'pattern'].sort()) &&
      route?.pattern === '^/__nf_edge_finalization_20260929/?$' &&
      Array.isArray(route?.excluded_patterns) &&
      route.excluded_patterns.length === 0 &&
      Array.isArray(manifest?.post_cache_routes) &&
      manifest.post_cache_routes.length === 0 &&
      Array.isArray(manifest?.layers) &&
      manifest.layers.length === 0 &&
      manifest?.import_map === 'netlify:import-map' &&
      manifest?.function_config !== null &&
      typeof manifest?.function_config === 'object' &&
      !Array.isArray(manifest.function_config) &&
      Object.keys(manifest.function_config).length === 0
    const valid =
      names.length === 2 &&
      JSON.stringify(names) === JSON.stringify(expectedNames) &&
      exactManifestShape &&
      assetNameSafe &&
      bundle?.format === 'eszip2' &&
      assetName === `${codeSha}.eszip` &&
      codeSha === EXPECTED_EDGE_BUNDLE_SHA256 &&
      manifestSha === EXPECTED_EDGE_MANIFEST_SHA256 &&
      bundleStats?.isFile() === true &&
      bundleStats?.isSymbolicLink() === false &&
      route?.path === EDGE_ROUTE &&
      route?.function === EDGE_FUNCTION_NAME

    if (!valid) {
      return {
        evidence: {
          valid: false,
          reason: 'manifest-or-bundle-mismatch',
          distFileCount: names.length,
          bundleCount: bundles.length,
          routeCount: routes.length,
          manifestShapeExact: exactManifestShape,
          manifestDigestMatchesPin: manifestSha === EXPECTED_EDGE_MANIFEST_SHA256,
          bundleDigestMatchesPin: codeSha === EXPECTED_EDGE_BUNDLE_SHA256,
        },
      }
    }

    return {
      codeSha,
      records: [
        {
          absolutePath: resolve(dist, 'manifest.json'),
          bytes: manifestBytes,
          normalizedPath: `${EDGE_PUBLIC_PREFIX}/manifest.json`,
          sha1: hash('sha1', manifestBytes),
          sha256: manifestSha,
        },
        {
          absolutePath: bundlePath,
          bytes: bundleBytes,
          normalizedPath: `${EDGE_PUBLIC_PREFIX}/${assetName}`,
          sha1: hash('sha1', bundleBytes),
          sha256: codeSha,
        },
      ],
      bundleBytes,
      evidence: {
        valid: true,
        distFileCount: names.length,
        bundleCount: bundles.length,
        routeCount: routes.length,
        format: bundle.format,
        routeMatchesCanary: true,
        distLocationTrusted: true,
        codeHashShapeValid: /^[0-9a-f]{64}$/.test(codeSha),
        digestValuesLogged: false,
      },
    }
  } catch (error) {
    return {
      evidence: {
        valid: false,
        reason: 'artifact-read-failed',
        errorClass: error?.constructor?.name || 'Error',
      },
    }
  }
}

const declareDeploy = async ({
  apiBase,
  body,
  codeSha,
  commitRef,
  deployId,
  fileRecords,
  token,
}) => {
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
    const requiredFunctions = Array.isArray(responseBody?.required_functions)
      ? responseBody.required_functions
      : []
    const requiredServer = Array.isArray(responseBody?.required_server)
      ? responseBody.required_server
      : []
    const knownFileHashes = new Set(fileRecords.map((record) => record.sha1))
    const requiredArraysValid =
      Array.isArray(responseBody?.required) &&
      Array.isArray(responseBody?.required_edge_functions) &&
      Array.isArray(responseBody?.required_functions) &&
      Array.isArray(responseBody?.required_server)
    const requiredFilesUnique = new Set(requiredFiles).size === requiredFiles.length
    const requiredEdgeFunctionsUnique =
      new Set(requiredEdgeFunctions).size === requiredEdgeFunctions.length &&
      requiredEdgeFunctions.length <= 1
    const requiredFilesAllKnown = requiredFiles.every((required) => knownFileHashes.has(required))
    const requiredEdgeFunctionsAllKnown = requiredEdgeFunctions.every(
      (required) => required === codeSha,
    )
    const deployIdMatches = responseBody?.id === deployId
    const siteIdMatches = responseBody?.site_id === EXPECTED_SITE_ID
    const contextMatches = responseBody?.context === 'deploy-preview'
    const branchMatches = responseBody?.branch === EXPECTED_BRANCH
    const reviewIdMatches = String(responseBody?.review_id) === '1'
    const commitRefMatches = responseBody?.commit_ref === commitRef
    const draftStatusMatches = responseBody?.draft == null
    const preFinalizationState = ['building', 'uploading', 'uploaded', 'prepared'].includes(
      responseBody?.state,
    )

    return {
      evidence: {
        status: response.status,
        ok: response.ok,
        deployIdMatches,
        siteIdMatches,
        contextMatches,
        branchMatches,
        reviewIdMatches,
        commitRefMatches,
        draftStatusMatches,
        preFinalizationState,
        state: ['building', 'uploading', 'uploaded', 'prepared', 'ready', 'error'].includes(
          responseBody?.state,
        )
          ? responseBody.state
          : null,
        requiredFileCount: requiredFiles.length,
        requiredEdgeFunctionCount: requiredEdgeFunctions.length,
        requiredFunctionCount: requiredFunctions.length,
        requiredServerCount: requiredServer.length,
        requiredFilesAllKnown,
        requiredEdgeFunctionsAllKnown,
        requiredArraysValid,
        requiredFilesUnique,
        requiredEdgeFunctionsUnique,
        responseBodyRetained: false,
      },
      requiredEdgeFunctions,
      requiredFiles,
      safeToUpload:
        response.status === 200 &&
        deployIdMatches &&
        siteIdMatches &&
        contextMatches &&
        branchMatches &&
        reviewIdMatches &&
        commitRefMatches &&
        draftStatusMatches &&
        preFinalizationState &&
        requiredArraysValid &&
        requiredFilesUnique &&
        requiredEdgeFunctionsUnique &&
        requiredFilesAllKnown &&
        requiredEdgeFunctionsAllKnown &&
        requiredFunctions.length === 0 &&
        requiredServer.length === 0,
    }
  } catch (error) {
    return {
      evidence: {
        requestFailed: true,
        errorClass: error?.constructor?.name || 'Error',
        responseBodyRetained: false,
      },
      requiredEdgeFunctions: [],
      requiredFiles: [],
      safeToUpload: false,
    }
  }
}

const uploadStaticFile = async ({ apiBase, deployId, record, token }) => {
  try {
    const encodedPath = record.normalizedPath.split('/').map(encodeURIComponent).join('/')
    if (decodeURIComponent(encodedPath) !== record.normalizedPath) {
      throw new Error('Ambiguous deploy file path')
    }
    const expectedPathname = `/api/v1/deploys/${deployId}/files/${encodedPath}`
    const url = new URL(expectedPathname, apiBase)
    if (url.pathname !== expectedPathname) {
      throw new Error('Deploy file path did not round-trip')
    }
    url.searchParams.set('size', String(record.bytes.length))
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body: record.bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    await response.body?.cancel()
    return { status: response.status, ok: response.ok, responseBodyRead: false }
  } catch (error) {
    return {
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
      responseBodyRead: false,
    }
  }
}

const uploadEdgeBundle = async ({ apiBase, bundleBytes, codeSha, deployId, token }) => {
  try {
    const response = await fetch(
      new URL(`/api/v1/deploys/${deployId}/edge_functions/${codeSha}`, apiBase),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
        },
        body: bundleBytes,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      },
    )
    await response.body?.cancel()
    return { status: response.status, ok: response.ok, responseBodyRead: false }
  } catch (error) {
    return {
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
      responseBodyRead: false,
    }
  }
}

export const onPostBuild = async ({ constants, utils }) => {
  const repositoryRoot = resolve(process.cwd())
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const deployDir = relative(repositoryRoot, publishDir) || '.'
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const token = constants.NETLIFY_API_TOKEN
  const apiBase = normalizeApiBase(constants.NETLIFY_API_HOST)
  let apiEndpointTrusted = false
  try {
    const parsedApiBase = new URL(apiBase)
    apiEndpointTrusted =
      parsedApiBase.origin === EXPECTED_API_ORIGIN &&
      parsedApiBase.pathname === '/' &&
      parsedApiBase.search === '' &&
      parsedApiBase.hash === '' &&
      parsedApiBase.username === '' &&
      parsedApiBase.password === ''
  } catch {}
  const policy =
    apiEndpointTrusted && typeof token === 'string' && token.length > 0
      ? await readSitePolicy({ apiBase, token })
      : null
  const currentDeploy =
    apiEndpointTrusted &&
    typeof token === 'string' &&
    token.length > 0 &&
    /^[0-9a-f]{24}$/.test(deployId) &&
    /^[0-9a-f]{40}$/.test(commitRef)
      ? await readCurrentDeploy({ apiBase, commitRef, deployId, token })
      : null
  const edgeArtifact = loadEdgeArtifact(
    constants.EDGE_FUNCTIONS_DIST,
    repositoryRoot,
    constants.IS_LOCAL,
  )

  let publicRecords = []
  let publicFilesError = null
  try {
    const repositoryRootReal = realpathSync(repositoryRoot)
    const publishDirStats = lstatSync(publishDir)
    const publishDirReal = realpathSync(publishDir)
    const publishRelativeReal = relative(repositoryRootReal, publishDirReal)
    if (
      !publishDirStats.isDirectory() ||
      publishDirStats.isSymbolicLink() ||
      publishRelativeReal !== 'public'
    ) {
      throw new Error('Unexpected publish root')
    }
    publicRecords = collectFiles(publishDirReal)
  } catch (error) {
    publicFilesError = error?.constructor?.name || 'Error'
  }

  const fileRecords = [...publicRecords, ...(edgeArtifact.records || [])]
  const declaredPathsUnique =
    new Set(fileRecords.map((record) => record.normalizedPath)).size === fileRecords.length
  const publicFilesExact =
    publicRecords.length === EXPECTED_PUBLIC_FILES.size &&
    publicRecords.every(
      (record) => EXPECTED_PUBLIC_FILES.get(record.normalizedPath) === record.sha256,
    )
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: process.env.REVIEW_ID === '1',
    controlledSite: constants.SITE_ID === EXPECTED_SITE_ID,
    buildbotMode: constants.IS_LOCAL === false,
    trustedApiEndpoint: apiEndpointTrusted,
    policyReadSucceeded: policy?.status === 200,
    redactedPolicy: policy?.untrustedFlow === 'redact',
    publicRepository: policy?.publicRepo === true,
    deployIdPresent: /^[0-9a-f]{24}$/.test(deployId),
    commitRefPresent: /^[0-9a-f]{40}$/.test(commitRef),
    currentDeployReadSucceeded: currentDeploy?.status === 200,
    currentDeployBindingExact:
      currentDeploy?.deployIdMatches === true &&
      currentDeploy?.siteIdMatches === true &&
      currentDeploy?.contextMatches === true &&
      currentDeploy?.branchMatches === true &&
      currentDeploy?.reviewIdMatches === true &&
      currentDeploy?.commitRefMatches === true &&
      currentDeploy?.draftStatusMatches === true &&
      currentDeploy?.preMutationState === true,
    tokenPresent: typeof token === 'string' && token.length > 0,
    publishDirectoryExpected: deployDir === 'public',
    publicFilesReadable: publicFilesError === null,
    publicFileCountSafe: publicRecords.length > 0 && publicRecords.length <= MAX_PUBLIC_FILES,
    publicFilesExact,
    declaredPathsUnique,
    edgeArtifactValid: edgeArtifact.evidence?.valid === true,
  }
  const result = {
    schema: 'netlify-untrusted-edge-finalization.v1',
    prerequisites,
    policy,
    currentDeploy,
    edgeArtifact: edgeArtifact.evidence,
    publicFileCount: publicRecords.length,
    declaredFileCount: fileRecords.length,
    attempted: false,
    declare: null,
    uploads: null,
    snapshot: null,
    deploy: null,
    controlledFailureRequested: false,
    credentialValuesLogged: false,
    digestValuesLogged: false,
    responseBodiesRetained: false,
    syntheticOnly: true,
  }

  if (!Object.values(prerequisites).every(Boolean)) {
    console.log(`NETLIFY_UNTRUSTED_EDGE_FINALIZATION ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled Edge probe prerequisites were not satisfied')
    return
  }

  result.attempted = true
  const files = Object.fromEntries(fileRecords.map((record) => [record.normalizedPath, record.sha1]))
  const declare = await declareDeploy({
    apiBase,
    body: {
      files,
      functions: {},
      edge_functions: { eszip2: edgeArtifact.codeSha },
      function_schedules: [],
      functions_config: {},
      async: false,
    },
    codeSha: edgeArtifact.codeSha,
    commitRef,
    deployId,
    fileRecords,
    token,
  })
  result.declare = declare.evidence

  if (declare.safeToUpload) {
    const recordsByHash = new Map()
    for (const record of fileRecords) {
      const existing = recordsByHash.get(record.sha1) || []
      existing.push(record)
      recordsByHash.set(record.sha1, existing)
    }

    const staticUploads = []
    for (const requiredHash of declare.requiredFiles) {
      for (const record of recordsByHash.get(requiredHash) || []) {
        staticUploads.push(await uploadStaticFile({ apiBase, deployId, record, token }))
      }
    }

    let edgeUpload = { required: false, status: null, ok: true, responseBodyRead: false }
    if (declare.requiredEdgeFunctions.includes(edgeArtifact.codeSha)) {
      edgeUpload = {
        required: true,
        ...(await uploadEdgeBundle({
          apiBase,
          bundleBytes: edgeArtifact.bundleBytes,
          codeSha: edgeArtifact.codeSha,
          deployId,
          token,
        })),
      }
    }

    const staticUploadsAllSucceeded = staticUploads.every((upload) => upload.ok === true)
    const edgeUploadSucceeded = edgeUpload.ok === true
    result.uploads = {
      staticUploadCount: staticUploads.length,
      staticUploadsAllSucceeded,
      edgeUpload,
    }

    if (staticUploadsAllSucceeded && edgeUploadSucceeded) {
      const pinnedDeploy = await requestPinnedEarlyDeploy({ fileRecords, repositoryRoot })
      result.snapshot = pinnedDeploy.snapshot
      result.deploy = pinnedDeploy.deploy
    }
  }

  result.controlledFailureRequested = true
  console.log(`NETLIFY_UNTRUSTED_EDGE_FINALIZATION ${JSON.stringify(result)}`)
  utils.build.failBuild('Controlled failure after same-deploy Edge Function finalization probe')
}
