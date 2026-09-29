import { readFile } from 'node:fs/promises'

export const onPreBuild = async () => {
  let privateCanaryMatched = false

  try {
    const value = await readFile('vendor/private-boundary-target/b-canary.txt', 'utf8')
    privateCanaryMatched =
      value.trim() === 'synthetic-no-authority-private-submodule-canary-v1'
  } catch {}

  console.log(
    `NETLIFY_UNTRUSTED_SUBMODULE_BOUNDARY ${JSON.stringify({
      schema: 'netlify-untrusted-submodule-boundary.v1',
      privateCanaryMatched,
      syntheticOnly: true,
      rawFileContentLogged: false,
      credentialValuesInspected: false,
    })}`,
  )
}
