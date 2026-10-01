const NONCE = 'netlify-edge-digest-untrusted-declared-a-20261001-v1'

export default async () =>
  Response.json(
    {
      schema: 'netlify-edge-digest-untrusted-runtime-oracle.v1',
      nonce: NONCE,
      variant: 'declared-a',
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
  path: '/__nf_edge_digest_20261001_v1',
}
