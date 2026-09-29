import { getStore } from '@netlify/blobs'

const CONTROLLED_SITE_ID = 'a13832a0-b3f7-40cb-a07f-df10e6929241'
const PRODUCTION_SECRET_KEY = 'NETLIFY_PREVIEW_GUARD_SECRET'
const STORE_NAME = 'netlify-security-oracle'

const getResult = (event) => ({
  schema: 'netlify-build-token-function-runtime-oracle.v1',
  functionExecuted: true,
  eventContextIsDeployPreview: event?.deploy?.context === 'deploy-preview',
  eventSiteMatchesControlled: event?.site?.id === CONTROLLED_SITE_ID,
  eventDeployIdPresent: typeof event?.deploy?.id === 'string' && event.deploy.id.length > 0,
  productionSecretPresent: typeof process.env[PRODUCTION_SECRET_KEY] === 'string',
  syntheticOnly: true,
  secretMaterialRead: false,
  credentialValuesLogged: false,
})

export default {
  fetch() {
    return Response.json(getResult(), { headers: { 'cache-control': 'no-store' } })
  },
  async deploySucceeded(event) {
    await getStore({ name: STORE_NAME, consistency: 'strong' }).setJSON(
      `cross-site-function-injection/${event.deploy.id}`,
      getResult(event),
    )
  },
}
