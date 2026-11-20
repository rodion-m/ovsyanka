// Every e2e spec imports `test`, `expect` and `_electron` from here instead of '@playwright/test'.
// The app's profile (YOGURT_USER_DATA) and any other scratch folder come from `tempDir(name)`; after each test
// the apps it launched are closed and its folders removed, also when the test failed or timed out.
// YOGURT_KEEP_TEMP=1 keeps the folders and lists them on the test's annotations, for debugging.
import { _electron as playwrightElectron, test as base, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export { expect } from '@playwright/test'
export type { ElectronApplication, Locator, Page } from '@playwright/test'

type Scope = { dirs: string[]; apps: ElectronApplication[] }
const worker: Scope = { dirs: [], apps: [] }
let current: Scope | undefined
const keep = () => process.env.YOGURT_KEEP_TEMP === '1'

// a fresh folder named yogurt-<name>-XXXXXX in the system temp folder, removed when the test ends
export function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yogurt-${name}-`))
  ;(current ?? worker).dirs.push(dir)
  return dir
}

const launch: typeof playwrightElectron.launch = async (options) => {
  const app = await playwrightElectron.launch(options)
  ;(current ?? worker).apps.push(app)
  return app
}
export const _electron = { launch }

// an app still running here belongs to a test that failed or timed out before its own app.close()
async function close(app: ElectronApplication) {
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10_000))])
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
}

async function release(scope: Scope, annotate?: (dir: string) => void) {
  const apps = scope.apps.splice(0), dirs = scope.dirs.splice(0)
  await Promise.all(apps.map(close))
  for (const dir of dirs) {
    if (keep()) annotate?.(dir)
    else rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

export const test = base.extend<{ cleanTemp: void }, { cleanWorkerTemp: void }>({
  cleanTemp: [async ({}, use, testInfo) => {
    current = { dirs: [], apps: [] }
    const scope = current
    try { await use() } finally {
      current = undefined
      await release(scope, (dir) => testInfo.annotations.push({ type: 'kept temp folder', description: dir }))
    }
  }, { auto: true, timeout: 30_000 }],
  cleanWorkerTemp: [async ({}, use) => {
    try { await use() } finally { await release(worker, (dir) => console.log(`kept temp folder ${dir}`)) }
  }, { auto: true, scope: 'worker', timeout: 30_000 }],
})
