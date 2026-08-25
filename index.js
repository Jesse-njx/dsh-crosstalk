import { buildLib } from './scripts/build-lib.mjs'

await buildLib()
const plugin = await import('./lib/index.js')

export const name = plugin.name
export const inject = plugin.inject
export const Config = plugin.Config
export const apply = plugin.apply
export default { name, inject, Config, apply }
