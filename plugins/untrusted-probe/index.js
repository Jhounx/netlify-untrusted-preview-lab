import { readFile } from 'node:fs/promises'

export const onPreBuild = async () => {
  let pointerPresent = false
  let privateObjectHydrated = false

  try {
    const value = await readFile('lfs-canary.bin', 'utf8')
    pointerPresent =
      value.includes('version https://git-lfs.github.com/spec/v1') &&
      value.includes('oid sha256:7df824adde91bc6bee32a4b3e64a188c210cf84df0370bb80fd34afdd3bc6ec0')
    privateObjectHydrated =
      value.trim() === 'synthetic-no-authority-private-lfs-object-v1'
  } catch {}

  console.log(
    `NETLIFY_UNTRUSTED_LFS_BOUNDARY ${JSON.stringify({
      schema: 'netlify-untrusted-lfs-boundary.v1',
      pointerPresent,
      privateObjectHydrated,
      syntheticOnly: true,
      rawFileContentLogged: false,
      credentialValuesInspected: false,
    })}`,
  )
}
