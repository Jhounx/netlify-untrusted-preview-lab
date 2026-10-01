const NONCE = 'netlify-edge-scanner-approved-source-20261001-v1'

export default async (request) =>
  Response.json(
    {
      schema: 'netlify-edge-scanner-binding-runtime-oracle.v1',
      nonce: NONCE,
      variant: 'scanner-approved-source',
      challengeHeaderPresent: request.headers.has('x-netlify-synthetic-canary'),
      challengeMatched: false,
      embeddedSyntheticCanary: false,
      syntheticOnly: true,
    },
    {
      headers: {
        'cache-control': 'no-store',
        'x-netlify-controlled-probe': NONCE,
      },
    },
  )

export const config = {
  path: '/__nf_edge_scanner_binding_20261001_v1',
}
