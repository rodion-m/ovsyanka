import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Tests once left their profiles in the system temp folder: thousands of yogurt-* folders, gigabytes in two days.
// Scratch folders come from tempDir() (test/support/tempDir.ts, e2e/support/playwright.ts), which removes them.
const app = join(import.meta.dirname, '..')
const helpers = ['test/support/tempDir.ts', 'e2e/support/playwright.ts', 'test/tempDirGuard.test.ts']
// makes its folders inside the checkout, not the system temp folder, and removes them in its own afterEach
const allowed = ['test/harness.test.ts']

function sources(dir: string): string[] {
  return readdirSync(join(app, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => relative(app, join(e.parentPath, e.name)).split('\\').join('/'))
    .filter((f) => !helpers.includes(f) && !f.includes('/fixtures/'))
}

function offending(files: string[], pattern: RegExp) {
  return files.flatMap((f) => readFileSync(join(app, f), 'utf8').split('\n')
    .flatMap((line, i) => pattern.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []))
}

describe('temporary folders in tests', () => {
  const files = [...sources('test'), ...sources('e2e')]

  it('are made only through tempDir(), which removes them', () => {
    const made = new RegExp(String.raw`\bmkdtemp(Sync)?\(|\bmkdir(Sync)?\([^)]*tmpdir\(\)`)
    expect(offending(files.filter((f) => !allowed.includes(f)), made)).toEqual([])
  })

  it('e2e specs launch the app through the helper, which closes it when a test fails or times out', () => {
    const direct = new RegExp(String.raw`^import \{[^}]*\b(_electron|test)\b[^}]*\} from '@playwright/test'`)
    expect(offending(files.filter((f) => f.startsWith('e2e/')), direct)).toEqual([])
  })
})
