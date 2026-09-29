import { getStore } from '@netlify/blobs'

const TARGET_SITE_ID = 'a13832a0-b3f7-40cb-a07f-df10e6929241'
const TARGET_STORE = 'netlify-cross-site-boundary-canary'
const TARGET_KEY = 'site-b-owner-fixture-v1'
const EXPECTED_VALUE = 'synthetic-no-authority-cross-site-blob-canary-v1'
const ORACLE_STORE = 'netlify-security-oracle'

export default {
  async deploySucceeded(event) {
    const result = {
      schema: 'netlify-untrusted-cross-site-blobs-boundary.v1',
      eventContextIsDeployPreview: event?.deploy?.context === 'deploy-preview',
      eventSiteIsSourceSite: event?.site?.id === '43a2f4e4-df31-455e-85bc-21f37fae92cd',
      targetIsDifferentControlledSite: event?.site?.id !== TARGET_SITE_ID,
      automaticTokenUsed: true,
      explicitTokenProvided: false,
      exactTargetSiteIdProvided: true,
      exactTargetStoreAndKeyProvided: true,
      syntheticOnly: true,
      rawBlobValueLogged: false,
      crossSiteReadReturnedValue: false,
      crossSiteCanaryMatched: false,
      readError: false,
    }

    try {
      const targetStore = getStore({
        name: TARGET_STORE,
        siteID: TARGET_SITE_ID,
        consistency: 'strong',
      })
      const value = await targetStore.get(TARGET_KEY, {
        type: 'text',
        consistency: 'strong',
      })
      result.crossSiteReadReturnedValue = value !== null
      result.crossSiteCanaryMatched = value === EXPECTED_VALUE
    } catch (error) {
      result.readError = true
      result.errorClass = error?.constructor?.name || 'Error'
    }

    const oracleStore = getStore({ name: ORACLE_STORE, consistency: 'strong' })
    await oracleStore.setJSON(`cross-site/${event.deploy.id}`, result)
  },
}
