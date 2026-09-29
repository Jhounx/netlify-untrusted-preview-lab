const CONTROLLED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const SYNTHETIC_SITE_ID = 'synthetic-boxed-site-id-canary-20260929-v1'

export const onPostBuild = async ({ constants, utils }) => {
  const prerequisites = {
    deployPreview: process.env.CONTEXT === 'deploy-preview',
    controlledReview: process.env.REVIEW_ID === '1',
    controlledSite: constants.SITE_ID === CONTROLLED_SITE_ID,
    deployEnvApiPresent: typeof utils?.deploy?.env?.add === 'function',
  }
  const result = {
    schema: 'netlify-boxed-site-id-deploy-env-probe.v1',
    prerequisites,
    syntheticOnly: true,
    externalAuthorityPresent: false,
    rawEnvironmentValueLogged: false,
    functionsScopeOnly: true,
    attempted: false,
  }

  if (!Object.values(prerequisites).every(Boolean)) {
    console.log(`NETLIFY_BOXED_SITE_ID_PROBE ${JSON.stringify(result)}`)
    return
  }

  const boxedKey = new String('SITE_ID')
  result.attempted = true
  result.keyType = typeof boxedKey
  result.primitiveReservedSetWouldMatch = new Set(['SITE_ID']).has(boxedKey)
  result.stringCoercionMatchesReservedKey = String(boxedKey) === 'SITE_ID'

  try {
    const returned = utils.deploy.env.add(boxedKey, SYNTHETIC_SITE_ID, {
      isSecret: false,
      scopes: ['functions'],
    })
    result.clientAccepted = true
    result.returnedUtilityObject = returned === utils.deploy.env
  } catch (error) {
    result.clientAccepted = false
    result.errorClass = error?.constructor?.name || 'Error'
  }

  console.log(`NETLIFY_BOXED_SITE_ID_PROBE ${JSON.stringify(result)}`)
}
