// Unit tests take scratch folders from `tempDir(name)` instead of mkdtemp in the system temp folder.
// A folder made during a test is removed after that test (after the file's own afterEach, so stores are closed first);
// one made while the file loads or in beforeAll is removed after the file. vitest.config.ts loads this as a setup file.
// YOGURT_KEEP_TEMP=1 keeps the folders and prints where they are, for debugging.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

const file: string[] = []
let test: string[] | undefined

// a fresh folder named yogurt-<name>-XXXXXX in the system temp folder
export function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yogurt-${name}-`))
  ;(test ?? file).push(dir)
  return dir
}

function remove(dirs: string[]) {
  for (const dir of dirs.splice(0)) {
    if (process.env.YOGURT_KEEP_TEMP === '1') console.log(`kept temp folder ${dir}`)
    else rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

// hooks run in reverse order of registration, and this file registers before the test file does
export function registerTempDirCleanup() {
  beforeEach(() => { test = [] })
  afterEach(() => { const dirs = test ?? []; test = undefined; remove(dirs) })
  afterAll(() => remove(file))
}
