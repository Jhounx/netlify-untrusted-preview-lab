const NONCE = 'netlify-edge-finalization-20260929'

export default async () =>
  Response.json(
    {
      schema: 'netlify-untrusted-edge-runtime-oracle.v1',
      nonce: NONCE,
      edgeFunctionExecuted: true,
      syntheticOnly: true,
    },
    { headers: { 'cache-control': 'no-store' } },
  )

export const config = { path: '/__nf_edge_finalization_20260929' }
