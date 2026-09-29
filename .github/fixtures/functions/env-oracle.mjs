const EXPECTED_SITE_ID = 'synthetic-boxed-site-id-canary-20260929-v1'
const CONTROLLED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'

export default {
  deploySucceeded(event) {
    const result = {
      schema: 'netlify-boxed-site-id-oracle.v1',
      eventContextIsDeployPreview: event?.deploy?.context === 'deploy-preview',
      eventSiteMatchesControlled: event?.site?.id === CONTROLLED_SITE_ID,
      eventDeployIdPresent: typeof event?.deploy?.id === 'string' && event.deploy.id.length > 0,
      envSiteIdPresent: typeof process.env.SITE_ID === 'string',
      envSiteIdMatchesSynthetic: process.env.SITE_ID === EXPECTED_SITE_ID,
      syntheticOnly: true,
      rawEnvironmentValueLogged: false,
      oracleTransport: 'controlled-error',
    }

    throw new Error(`NETLIFY_BOXED_SITE_ID_ORACLE ${JSON.stringify(result)}`)
  },
}
