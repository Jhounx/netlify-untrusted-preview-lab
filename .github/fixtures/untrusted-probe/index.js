const EXPECTED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const EXPECTED_ACCOUNT_ID = '6abaad6d9668e14593d47aee'
const EXPECTED_ACCOUNT_SLUG = 'jhounx'
const CONTROLLED_SIBLING_SITE_ID = 'a13832a0-b3f7-40cb-a07f-df10e6929241'

const normalizeApiBase = (value) =>
  /^https?:\/\//i.test(value || '') ? value : `https://${value || 'api.netlify.com'}`

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
    return { requestFailed: true, errorClass: error?.constructor?.name || 'Error' }
  }
}

const requestStatusWithoutBody = async ({ apiBase, path, token }) => {
  try {
    const response = await fetch(new URL(path, apiBase), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel()
    return {
      status: response.status,
      ok: response.ok,
      responseBodyRead: false,
    }
  } catch (error) {
    return {
      status: null,
      ok: false,
      responseBodyRead: false,
      requestFailed: true,
      errorClass: error?.constructor?.name || 'Error',
    }
  }
}

export const onPostBuild = async ({ constants }) => {
  const token = constants.NETLIFY_API_TOKEN
  const apiBase = normalizeApiBase(constants.NETLIFY_API_HOST)
  const policy = typeof token === 'string' && token.length > 0 ? await readPolicy({ apiBase, token }) : null
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: process.env.REVIEW_ID === '1',
    controlledSite: constants.SITE_ID === EXPECTED_SITE_ID,
    controlledAccount: constants.ACCOUNT_ID === EXPECTED_ACCOUNT_ID,
    tokenPresent: typeof token === 'string' && token.length > 0,
    redactedPolicy: policy?.untrustedFlow === 'redact',
    publicRepository: policy?.publicRepo === true,
  }
  const result = {
    schema: 'netlify-untrusted-read-capability-matrix.v1',
    prerequisites,
    policy,
    attempted: false,
    method: 'GET',
    responseBodiesRead: false,
    credentialValuesLogged: false,
    secretMaterialRead: false,
    syntheticOnly: true,
    endpoints: {},
  }

  if (!Object.values(prerequisites).every(Boolean)) {
    console.log(`NETLIFY_UNTRUSTED_READ_CAPABILITY_MATRIX ${JSON.stringify(result)}`)
    return
  }

  result.attempted = true
  const probes = {
    currentSite: `/api/v1/sites/${EXPECTED_SITE_ID}`,
    controlledSiblingSite: `/api/v1/sites/${CONTROLLED_SIBLING_SITE_ID}`,
    account: `/api/v1/accounts/${EXPECTED_ACCOUNT_ID}`,
    accountMembers: `/api/v1/${EXPECTED_ACCOUNT_SLUG}/members`,
    accountSites: `/api/v1/${EXPECTED_ACCOUNT_SLUG}/sites?per_page=1`,
    accountAudit: `/api/v1/accounts/${EXPECTED_ACCOUNT_ID}/audit?per_page=1`,
    accountAiGatewayToken: `/api/v1/accounts/${EXPECTED_ACCOUNT_ID}/ai-gateway/token`,
    accountBuildStatus: `/api/v1/${EXPECTED_ACCOUNT_ID}/builds/status`,
    siteDatabaseOwner: `/api/v1/sites/${EXPECTED_SITE_ID}/database?role=owner`,
    agentRunners: `/api/v1/agent_runners?site_id=${EXPECTED_SITE_ID}&per_page=1`,
    siteAgentRunnerHooks: `/api/v1/sites/${EXPECTED_SITE_ID}/agent_runner_hooks`,
  }

  for (const [name, path] of Object.entries(probes)) {
    result.endpoints[name] = await requestStatusWithoutBody({ apiBase, path, token })
  }

  console.log(`NETLIFY_UNTRUSTED_READ_CAPABILITY_MATRIX ${JSON.stringify(result)}`)
}
