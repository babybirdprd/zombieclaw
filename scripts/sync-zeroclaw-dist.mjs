import { constants } from 'node:fs'
import { access, cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const rootDir = resolve(process.cwd())
const sourceDir = resolve(rootDir, 'vendor', 'zeroclaw-web', 'dist')
const targetDir = resolve(rootDir, 'dist-zeroclaw')

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

if (!(await pathExists(sourceDir))) {
  throw new Error(`ZeroClaw dist folder not found at ${sourceDir}`)
}

await rm(targetDir, { recursive: true, force: true })
await mkdir(targetDir, { recursive: true })
await cp(sourceDir, targetDir, { recursive: true })

console.log(`Synced ZeroClaw frontend bundle: ${targetDir}`)
