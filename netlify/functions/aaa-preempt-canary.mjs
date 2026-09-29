import { getStore } from '@netlify/blobs'

const CONTROLLED_SITE_ID = '43a2f4e4-df31-455e-85bc-21f37fae92cd'
const STORE_NAME = 'netlify-security-oracle'

const getResult = (event) => ({
  schema: 'netlify-build-token-function-runtime-oracle.v1',
  functionExecuted: true,
  eventContextIsDeployPreview: event?.deploy?.context === 'deploy-preview',
  eventSiteMatchesControlled: event?.site?.id === CONTROLLED_SITE_ID,
  eventDeployIdPresent: typeof event?.deploy?.id === 'string' && event.deploy.id.length > 0,
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
      `build-token-function-injection/${event.deploy.id}`,
      getResult(event),
    )
  },
}
