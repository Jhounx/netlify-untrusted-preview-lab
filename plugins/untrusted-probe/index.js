import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const TARGET_COMMIT_REF = '5302cfe62a6bedca234d2409ed48f1097fe27503'

const printResult = (result) => {
  console.log(`NETLIFY_UNTRUSTED_PROVENANCE_PROBE ${JSON.stringify(result)}`)
}

const buildFileManifest = (directory) => {
  const files = {}
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name)
      if (entry.isDirectory()) {
        visit(absolutePath)
      } else if (entry.isFile()) {
        const deployPath = relative(directory, absolutePath).split('\\').join('/')
        files[deployPath] = createHash('sha1').update(readFileSync(absolutePath)).digest('hex')
      }
    }
  }
  visit(directory)
  return files
}

export const onPostBuild = async ({ constants }) => {
  const token = constants.NETLIFY_API_TOKEN
  const siteId = constants.SITE_ID
  const deployId = process.env.DEPLOY_ID
  const apiHost = constants.NETLIFY_API_HOST || 'https://api.netlify.com'
  const publishDir = resolve(constants.PUBLISH_DIR || 'public')
  const files = buildFileManifest(publishDir)
  const result = {
    schema: 'netlify-untrusted-provenance-probe.v1',
    syntheticOnly: true,
    phase: 'onPostBuild-before-core-deploy',
    targetCommitRef: TARGET_COMMIT_REF,
    tokenPresent: typeof token === 'string' && token.length > 0,
    siteIdPresent: typeof siteId === 'string' && siteId.length > 0,
    deployIdPresent: typeof deployId === 'string' && deployId.length > 0,
    requestAttempted: false,
    declaredFileCount: Object.keys(files).length,
    httpStatus: null,
    errorCode: null,
    errorMessage: null,
    responseCommitRef: null,
    responseCommitUrlMatchesTarget: null,
    responseBranch: null,
    responseContext: null,
    responseReviewIdPresent: null,
  }

  if (!result.tokenPresent || !result.siteIdPresent || !result.deployIdPresent) {
    printResult(result)
    return
  }

  const normalizedHost = /^https?:\/\//i.test(apiHost) ? apiHost : `https://${apiHost}`
  const endpoint = new URL(
    `/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}`,
    normalizedHost,
  )
  endpoint.searchParams.set('commit_ref', TARGET_COMMIT_REF)

  try {
    result.requestAttempted = true
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })

    result.httpStatus = response.status
    if (response.ok) {
      const body = await response.json()
      result.responseCommitRef = body?.commit_ref ?? null
      result.responseCommitUrlMatchesTarget =
        typeof body?.commit_url === 'string' && body.commit_url.endsWith(`/commit/${TARGET_COMMIT_REF}`)
      result.responseBranch = body?.branch ?? null
      result.responseContext = body?.context ?? null
      result.responseReviewIdPresent = body?.review_id !== null && body?.review_id !== undefined
    } else {
      const body = await response.json().catch(() => null)
      result.errorCode = typeof body?.code === 'number' || typeof body?.code === 'string' ? body.code : null
      result.errorMessage = typeof body?.message === 'string' ? body.message.slice(0, 200) : null
    }
  } catch (error) {
    result.errorClass = error?.constructor?.name ?? 'UnknownError'
  }

  printResult(result)
}
