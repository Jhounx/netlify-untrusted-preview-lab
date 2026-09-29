import './controlled-missing-module.js'

export default async () => new Response('This controlled edge function must never deploy')
