import { access } from 'node:fs/promises'

await access(new URL('./public/index.html', import.meta.url))
console.log('Controlled static fixture ready')
