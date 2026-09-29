import { getStore } from '@netlify/blobs'

const STORE = 'netlify-security-oracle'
const KEY = 'failed-build-function/executable-v1'

export default async () => {
  let persistentWriteSucceeded = false

  try {
    const store = getStore({ name: STORE, consistency: 'strong' })
    await store.setJSON(KEY, {
      schema: 'netlify-failed-build-function-canary.v1',
      functionExecuted: true,
      automaticRuntimeIdentityUsed: true,
      syntheticOnly: true,
      secretMaterialRead: false,
      credentialValuesLogged: false,
    })
    persistentWriteSucceeded = true
  } catch {}

  return Response.json({
    schema: 'netlify-failed-build-function-response.v1',
    functionExecuted: true,
    persistentWriteSucceeded,
    syntheticOnly: true,
    secretMaterialReturned: false,
  })
}
