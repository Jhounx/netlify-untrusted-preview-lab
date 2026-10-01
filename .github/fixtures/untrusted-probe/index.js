export const onPostBuild = async () => {
  console.log(
    'NETLIFY_UNTRUSTED_CLEANUP {"phase":"cleanup","activeProbe":false,"serverProbeRemoved":true,"secretMaterialPublished":false}',
  )
}
