const NONCE = 'netlify-edge-core-race-native-b-20261001-v1'

export default async () =>
  Response.json({
    schema: 'netlify-edge-core-race.v1',
    nonce: NONCE,
    variant: 'native-core-b',
    syntheticOnly: true,
  })
