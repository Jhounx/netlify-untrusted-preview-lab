import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EDGE_FUNCTION_NAME = 'controlled-edge-canary'
const EDGE_ROUTE = '/__nf_edge_scanner_binding_20261001_v1'
const EDGE_PATTERN = '^/__nf_edge_scanner_binding_20261001_v1/?$'
const EDGE_PUBLIC_PREFIX = '.netlify/internal/edge-functions'
const CHALLENGE_HEADER = 'x-netlify-synthetic-secret'
const REPORT_WAIT_MS = 30_000

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const safeWriteJson = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

const normalizeApiBase = (value) =>
  /^https?:\/\//i.test(value || '') ? new URL(value) : new URL(`https://${value || 'api.netlify.com'}`)

const isInside = (parent, child) => {
  const pathFromParent = relative(parent, child)
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..')
}

const getSecretScan = (body) => {
  const report = body?.deploy_validations_report ?? body
  return report?.secrets_scan ?? report?.secret_scan_result
}

const summarizeScan = (scan) => ({
  present: scan !== null && typeof scan === 'object',
  scannedFilesCount: Number.isInteger(scan?.scannedFilesCount) ? scan.scannedFilesCount : null,
  secretsScanMatchCount: Array.isArray(scan?.secretsScanMatches)
    ? scan.secretsScanMatches.length
    : null,
  enhancedSecretsScanMatchCount: Array.isArray(scan?.enhancedSecretsScanMatches)
    ? scan.enhancedSecretsScanMatches.length
    : null,
})

const makeTarBundle = ({ source, variant }) => {
  const root = mkdtempSync(join(tmpdir(), `netlify-edge-scanner-${variant}-`))
  const input = resolve(root, 'input')
  const archive = resolve(root, `${variant}.tar.gz`)
  mkdirSync(input)
  const route = {
    function: EDGE_FUNCTION_NAME,
    pattern: EDGE_PATTERN,
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

const listPublishRecords = (publishDir) => {
  const records = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Unexpected publish symlink')
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (entry.isFile()) {
        const bytes = readFileSync(absolute)
        records.push({
          path: relative(publishDir, absolute).split(sep).join('/'),
          bytes,
          sha1: hash('sha1', bytes),
        })
      }
    }
  }
  walk(publishDir)
  return records
}

const stageApprovedArtifacts = ({ deployId, edgeDist, publishDir }) => {
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
    routes[0]?.pattern !== EDGE_PATTERN
  ) {
    throw new Error('Unexpected Edge manifest routes')
  }

  const approvedNonce = `netlify-edge-scanner-approved-a-${deployId}`
  const approvedSource = `
export default async (request) => Response.json({
  schema: 'netlify-edge-scanner-binding-runtime-oracle.v1',
  nonce: ${JSON.stringify(approvedNonce)},
  variant: 'scanner-approved-a',
  challengeHeaderPresent: request.headers.has(${JSON.stringify(CHALLENGE_HEADER)}),
  challengeMatched: false,
  embeddedSyntheticSecret: false,
  syntheticOnly: true,
}, { headers: { 'cache-control': 'no-store', 'x-netlify-controlled-probe': ${JSON.stringify(approvedNonce)} } })
`
  const approved = makeTarBundle({ source: approvedSource, variant: `approved-a-${deployId}` })
  const manifest = {
    ...originalManifest,
    bundles: [
      {
        asset: `${approved.sha256}.tar.gz`,
        format: 'tar',
        custom_import_map: false,
        vendor_manifest: false,
      },
      eszipDescriptor,
    ],
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const approvedAssetPath = resolve(edgeDistReal, `${approved.sha256}.tar.gz`)
  writeFileSync(approvedAssetPath, approved.bytes, { mode: 0o600 })
  const manifestTemporary = `${manifestPath}.${process.pid}.tmp`
  writeFileSync(manifestTemporary, manifestBytes, { mode: 0o600 })
  renameSync(manifestTemporary, manifestPath)

  const publishRecords = listPublishRecords(publishDir)
  const records = [
    ...publishRecords,
    {
      path: `${EDGE_PUBLIC_PREFIX}/manifest.json`,
      bytes: manifestBytes,
      sha1: hash('sha1', manifestBytes),
    },
    {
      path: `${EDGE_PUBLIC_PREFIX}/${approved.sha256}.tar.gz`,
      bytes: approved.bytes,
      sha1: approved.sha1,
    },
    {
      path: `${EDGE_PUBLIC_PREFIX}/${eszipDescriptor.asset}`,
      bytes: eszipBytes,
      sha1: hash('sha1', eszipBytes),
    },
  ]
  return {
    approved,
    approvedAssetPath,
    edgeDistReal,
    eszip: { asset: eszipDescriptor.asset, sha256: eszipSha256 },
    manifest: { sha1: hash('sha1', manifestBytes) },
    records,
  }
}

const fetchDeploy = async ({ apiBase, deployId, token }) => {
  try {
    const response = await fetch(new URL(`/api/v1/deploys/${deployId}`, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(2_000),
    })
    const body = response.ok ? await response.json() : null
    return { status: response.status, ok: response.ok, body }
  } catch (error) {
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

const deployIdentityMatches = ({ body, branch, commitRef, deployId, siteId }) =>
  body?.id === deployId &&
  body?.site_id === siteId &&
  body?.context === 'deploy-preview' &&
  body?.branch === branch &&
  String(body?.review_id) === '1' &&
  body?.commit_ref === commitRef

const waitForCleanScannerReport = async (context) => {
  const deadline = Date.now() + REPORT_WAIT_MS
  let attempts = 0
  let latest = null
  while (Date.now() < deadline) {
    attempts += 1
    latest = await fetchDeploy(context)
    const scan = getSecretScan(latest?.body)
    const summary = summarizeScan(scan)
    if (latest?.ok && summary.present) {
      const clean =
        Number.isInteger(summary.scannedFilesCount) &&
        summary.scannedFilesCount > 0 &&
        summary.secretsScanMatchCount === 0 &&
        summary.enhancedSecretsScanMatchCount === 0
      return {
        observed: true,
        clean,
        attempts,
        status: latest.status,
        identityMatches: deployIdentityMatches({ ...context, body: latest.body }),
        report: summary,
      }
    }
    await delay(25)
  }
  return {
    observed: false,
    clean: false,
    attempts,
    status: latest?.status ?? null,
    identityMatches: false,
    report: summarizeScan(null),
  }
}

const declareDeploy = async ({ apiBase, branch, commitRef, deployId, records, siteId, token, edge }) => {
  const files = Object.fromEntries(records.map((record) => [record.path, record.sha1]))
  const knownFiles = new Set(records.map((record) => record.sha1))
  try {
    const response = await fetch(new URL(`/api/v1/sites/${siteId}/deploys/${deployId}`, apiBase), {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        files,
        functions: {},
        edge_functions: { tar: edge.approved.sha256, eszip2: edge.eszip.sha256 },
        function_schedules: [],
        functions_config: {},
        async: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = response.ok ? await response.json() : null
    const requiredFiles = Array.isArray(body?.required) ? body.required : []
    const requiredEdge = Array.isArray(body?.required_edge_functions)
      ? body.required_edge_functions
      : []
    const requirementsValid =
      requiredFiles.every((value) => knownFiles.has(value)) &&
      requiredEdge.every((value) => value === edge.approved.sha256)
    return {
      status: response.status,
      ok: response.ok,
      identityMatches: deployIdentityMatches({ body, branch, commitRef, deployId, siteId }),
      requirementsValid,
      approvedDigestRequired: requiredEdge.includes(edge.approved.sha256),
      requiredFileCount: requiredFiles.length,
      requiredEdgeCount: requiredEdge.length,
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

const uploadSubstitutedBundle = async ({ apiBase, declaredSha, deployId, token, uploadedBytes }) => {
  try {
    const response = await fetch(
      new URL(`/api/v1/deploys/${deployId}/edge_functions/${declaredSha}`, apiBase),
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: uploadedBytes,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    )
    await response.body?.cancel()
    return { status: response.status, ok: response.ok, responseBodyRetained: false }
  } catch (error) {
    return {
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
      responseBodyRetained: false,
    }
  }
}

const run = async () => {
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.PROBE_COMMIT_REF || ''
  const siteId = process.env.PROBE_SITE_ID || ''
  const branch = process.env.PROBE_BRANCH || ''
  const token = process.env.PROBE_API_TOKEN || ''
  const apiBase = normalizeApiBase(process.env.PROBE_API_HOST)
  const edgeDist = resolve(process.env.PROBE_EDGE_DIST || '')
  const publishDir = resolve(process.env.PROBE_PUBLISH_DIR || '')
  const repositoryRoot = resolve(process.env.PROBE_REPOSITORY_ROOT || '')
  const readyPath = process.env.PROBE_READY_PATH || ''
  const resultPath = process.env.PROBE_RESULT_PATH || ''
  const secretKey = process.env.PROBE_SYNTHETIC_SECRET_KEY || ''
  const prerequisites = {
    deployIdValid: /^[0-9a-f]{24}$/.test(deployId),
    commitRefValid: /^[0-9a-f]{40}$/.test(commitRef),
    siteIdMatches: siteId === '43a2f4e4-df31-455e-85bc-21f37fae92cd',
    branchMatches: branch === 'bot/untrusted-preview-probe-36495196637',
    apiOriginTrusted: apiBase.origin === 'https://api.netlify.com',
    tokenPresent: token.length > 0,
    secretKeyMatches: secretKey === 'NETLIFY_VALIDATION_REPORT_SYNTHETIC_SECRET',
    syntheticSecretPresent: typeof process.env[secretKey] === 'string' && process.env[secretKey].length >= 32,
    edgeDistInsideRepository: isInside(repositoryRoot, edgeDist),
    publishDirInsideRepository: isInside(repositoryRoot, publishDir),
    edgeDistExists: existsSync(edgeDist) && statSync(edgeDist).isDirectory(),
    publishDirExists: existsSync(publishDir) && statSync(publishDir).isDirectory(),
  }
  const baseResult = {
    schema: 'netlify-edge-scanner-binding.v1',
    deployId,
    completed: false,
    prerequisites,
    scanner: null,
    declaration: null,
    substitutionUpload: null,
    artifacts: null,
    credentialValuesLogged: false,
    syntheticSecretValueLogged: false,
    syntheticSecretDigestLogged: false,
    responseBodiesRetained: false,
    syntheticOnly: true,
  }
  if (!Object.values(prerequisites).every(Boolean)) {
    safeWriteJson(readyPath, { ready: false, prerequisites })
    safeWriteJson(resultPath, baseResult)
    return
  }

  let edge = null
  let uploaded = null
  try {
    edge = stageApprovedArtifacts({ deployId, edgeDist, publishDir })
    safeWriteJson(readyPath, { ready: true, prerequisites })

    const context = { apiBase, branch, commitRef, deployId, siteId, token }
    const scanner = await waitForCleanScannerReport(context)
    baseResult.scanner = scanner
    if (!scanner.observed || !scanner.clean || !scanner.identityMatches) {
      safeWriteJson(resultPath, baseResult)
      return
    }

    const syntheticSecret = process.env[secretKey]
    const uploadedNonce = `netlify-edge-scanner-post-scan-b-${deployId}`
    const uploadedSource = `
const EMBEDDED_SYNTHETIC_SECRET = ${JSON.stringify(syntheticSecret)}
export default async (request) => Response.json({
  schema: 'netlify-edge-scanner-binding-runtime-oracle.v1',
  nonce: ${JSON.stringify(uploadedNonce)},
  variant: 'post-scan-uploaded-b',
  challengeHeaderPresent: request.headers.has(${JSON.stringify(CHALLENGE_HEADER)}),
  challengeMatched: request.headers.get(${JSON.stringify(CHALLENGE_HEADER)}) === EMBEDDED_SYNTHETIC_SECRET,
  embeddedSyntheticSecret: true,
  embeddedSyntheticSecretLength: EMBEDDED_SYNTHETIC_SECRET.length,
  syntheticOnly: true,
}, { headers: { 'cache-control': 'no-store', 'x-netlify-controlled-probe': ${JSON.stringify(uploadedNonce)} } })
`
    uploaded = makeTarBundle({ source: uploadedSource, variant: `uploaded-b-${deployId}` })
    baseResult.artifacts = {
      approvedTarSha256: edge.approved.sha256,
      uploadedTarSha256: uploaded.sha256,
      bytesEqual: edge.approved.bytes.equals(uploaded.bytes),
      syntheticSecretEmbeddedAfterScannerReport: true,
    }

    const declaration = await declareDeploy({ ...context, records: edge.records, edge })
    baseResult.declaration = declaration
    if (!declaration.ok || !declaration.identityMatches || !declaration.requirementsValid) {
      safeWriteJson(resultPath, baseResult)
      return
    }
    baseResult.substitutionUpload = await uploadSubstitutedBundle({
      apiBase,
      declaredSha: edge.approved.sha256,
      deployId,
      token,
      uploadedBytes: uploaded.bytes,
    })
    baseResult.completed = baseResult.substitutionUpload?.ok === true
    safeWriteJson(resultPath, baseResult)
  } finally {
    for (const artifact of [edge?.approved, uploaded]) {
      if (artifact?.root && artifact.root.startsWith(`${tmpdir()}${sep}netlify-edge-scanner-`)) {
        rmSync(artifact.root, { recursive: true, force: true })
      }
    }
  }
}

const recordFailure = (error) => {
  const resultPath = process.env.PROBE_RESULT_PATH || ''
  const readyPath = process.env.PROBE_READY_PATH || ''
  const failure = {
    schema: 'netlify-edge-scanner-binding.v1',
    deployId: process.env.DEPLOY_ID || '',
    completed: false,
    errorClass: error?.constructor?.name || 'Error',
    credentialValuesLogged: false,
    syntheticSecretValueLogged: false,
    syntheticSecretDigestLogged: false,
    responseBodiesRetained: false,
    syntheticOnly: true,
  }
  if (readyPath && !existsSync(readyPath)) safeWriteJson(readyPath, { ready: false, prerequisites: null })
  if (resultPath) safeWriteJson(resultPath, failure)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(recordFailure)
}
