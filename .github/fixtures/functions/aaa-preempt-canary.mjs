export default async () =>
  new Response(
    JSON.stringify({
      schema: 'netlify-post-bundle-function-canary.v1',
      functionExecuted: true,
      syntheticOnly: true,
      secretMaterialRead: false,
    }),
    { headers: { 'content-type': 'application/json' } },
  )
