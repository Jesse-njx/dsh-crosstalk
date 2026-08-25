import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import * as module from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function tsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

function rewriteImports(js) {
  return js
    .replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3')
}

function shouldBuild(root, files) {
  for (const src of files) {
    const rel = relative(join(root, 'src'), src).replace(/\.ts$/, '.js')
    const dest = join(root, 'lib', rel)
    if (!existsSync(dest) || statSync(dest).mtimeMs < statSync(src).mtimeMs) return true
  }
  return false
}

export function buildLib(root = defaultRoot) {
  const srcDir = join(root, 'src')
  const libDir = join(root, 'lib')
  if (!existsSync(srcDir)) {
    if (existsSync(join(libDir, 'index.js'))) return false
    throw new Error('dsh-crosstalk: missing src/ and lib/index.js; cannot build runtime files')
  }
  const files = tsFiles(srcDir)
  if (!shouldBuild(root, files)) return false
  const stripTypeScriptTypes = module.stripTypeScriptTypes
  if (typeof stripTypeScriptTypes !== 'function') {
    throw new Error('dsh-crosstalk: Node.js cannot compile TypeScript; run pnpm build before loading this plugin')
  }
  for (const src of files) {
    const rel = relative(srcDir, src).replace(/\.ts$/, '.js')
    const dest = join(libDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    const js = rewriteImports(stripTypeScriptTypes(readFileSync(src, 'utf8'), { mode: 'transform' }))
    writeFileSync(dest, `${js.trimEnd()}\n`)
  }
  return true
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildLib()
}
