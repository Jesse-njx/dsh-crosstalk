import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const inNodeModules = root.split(sep).includes('node_modules')
const entry = inNodeModules && existsSync(join(root, 'lib/index.js')) ? './lib/index.js' : './src/index.ts'
const plugin = await import(entry)

export const name = plugin.name
export const inject = plugin.inject
export const Config = plugin.Config
export const apply = plugin.apply
export default { name, inject, Config, apply }
