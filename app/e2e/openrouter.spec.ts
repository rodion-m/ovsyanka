import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOpenRouterServer } from './support/openrouterServer'

const main = join(import.meta.dirname, '../out/main/index.js')
const FAKE_KEY = `sk-or-v1-${'a'.repeat(64)}`
async function launch(url: string, userData: string) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_AI_BACKEND: '', YOGURT_TEST_OPENROUTER_URL: url, YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
async function configure(page: Page) {
  await page.getByTestId('settings-open').click()
  await page.getByTestId('ai-backend').selectOption('openrouter')
  const input = page.getByTestId('ai-openrouter-key')
  await input.fill(FAKE_KEY)
  await page.getByRole('button', { name: 'Check key' }).click()
  await expect(page.getByText(/Key works/)).toBeVisible()
  await expect(page.getByTestId('ai-openrouter-transcriptionModel-sub')).toContainText('google/gemini-3.8-flash')
  await expect(page.getByTestId('ai-openrouter-transcriptionModel-sub')).not.toContainText('custom ID')
  await page.getByTestId('ai-openrouter-transcriptionModel').click()
  await expect(page.getByRole('option', { name: /Fake STT/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-mode-description')).toContainText('Audio and text are sent to OpenRouter')
  await expect(page.getByTestId('ai-check')).toHaveCount(0)
  await expect(page.getByText(/Check the executable used by Yogurt/)).toHaveCount(0)
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-saved-pending')).toBeVisible()
}
async function relaunch(app: ElectronApplication, url: string, userData: string) {
  await app.close()
  return launch(url, userData)
}
async function recordShort(page: Page) {
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await page.waitForTimeout(5_500)
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click()
}

test('OpenRouter first run saves defaults, offers restart, and transcribes a short recording', async () => {
  const fake = await startOpenRouterServer()
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-openrouter-first-run-'))
  let { app, page } = await launch(fake.url, userData)
  try {
    await configure(page)
    await expect(page.getByTestId('openrouter-usage')).not.toContainText('$$')
    const keyRow = page.locator('.openrouter-key-row')
    await expect.poll(() => keyRow.locator('.settings-row-copy').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(120)
    await expect.poll(() => page.getByTestId('ai-openrouter-dataPolicy').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(380)
    await expect(page.getByTestId('ai-saved-pending')).toContainText('OpenRouter')
    ;({ app, page } = await relaunch(app, fake.url, userData))
    await recordShort(page)
    await expect.poll(() => fake.calls()).toBeGreaterThan(0)
    await page.getByRole('tab', { name: 'Transcript' }).click()
    await expect(page.getByTestId('transcript-text').filter({ hasText: 'Здравствуйте, проверка связи.' })).toHaveCount(2, { timeout: 60_000 })
  } finally { await app.close(); await fake.close() }
})

test('OpenRouter credits failure shows a banner; after funding, Retry writes transcript lines', async () => {
  const fake = await startOpenRouterServer()
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-openrouter-credits-'))
  let { app, page } = await launch(fake.url, userData)
  try {
    await configure(page)
    ;({ app, page } = await relaunch(app, fake.url, userData))
    fake.setCredits(true)
    await recordShort(page)
    await expect.poll(() => fake.calls()).toBeGreaterThan(0)
    await expect(page.getByText(/Your OpenRouter credits have run out/)).toBeVisible({ timeout: 60_000 })
    fake.setCredits(false)
    await page.getByTestId('note-transcript-retry').click()
    await page.getByRole('tab', { name: 'Transcript' }).click()
    await expect(page.getByTestId('transcript-text').filter({ hasText: 'Здравствуйте, проверка связи.' })).toHaveCount(2, { timeout: 60_000 })
  } finally { await app.close(); await fake.close() }
})
