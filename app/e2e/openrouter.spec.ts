import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOpenRouterServer } from './support/openrouterServer'

const main = join(import.meta.dirname, '../out/main/index.js')
const reviewEvidence = '/Users/rodio/.local/state/coordinator-mode/journals/yogurt-a940b5b7/evidence/cli-problems'
const FAKE_KEY = `sk-or-v1-${'a'.repeat(64)}`
async function launch(url: string, userData: string, lang: 'en' | 'ru' = 'en') {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_AI_BACKEND: '', YOGURT_TEST_OPENROUTER_URL: url, YOGURT_USER_DATA: userData, YOGURT_SYSTEM_LANGUAGES: lang === 'ru' ? 'ru-RU' : 'en-US' } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
async function configure(page: Page, lang: 'en' | 'ru' = 'en') {
  await page.getByTestId('settings-open').click()
  await page.getByTestId('ai-backend').selectOption('openrouter')
  const input = page.getByTestId('ai-openrouter-key')
  await input.fill(FAKE_KEY)
  await page.getByRole('button', { name: lang === 'ru' ? 'Сохранить и проверить ключ' : 'Save and check key' }).click()
  await expect(page.getByText(lang === 'ru' ? /Ключ сохранён в Связке ключей и работает/ : /Key saved in the Keychain and working/)).toBeVisible()
  await expect(page.getByTestId('ai-openrouter-transcriptionModel-sub')).toContainText('google/gemini-3.8-flash')
  await expect(page.getByTestId('ai-openrouter-transcriptionModel-sub')).not.toContainText('custom ID')
  await page.getByTestId('ai-openrouter-transcriptionModel').click()
  await expect(page.getByRole('option', { name: /Fake STT/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-mode-description')).toContainText(lang === 'ru' ? 'Аудио и текст отправляются в OpenRouter' : 'Audio and text are sent to OpenRouter')
  await expect(page.getByTestId('ai-check')).toHaveCount(0)
  await expect(page.getByText(lang === 'ru' ? /Проверьте CLI, который использует Yogurt/ : /Check the executable used by Yogurt/)).toHaveCount(0)
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-saved-pending')).toBeVisible()
}
async function relaunch(app: ElectronApplication, url: string, userData: string, lang: 'en' | 'ru' = 'en') {
  await app.close()
  return launch(url, userData, lang)
}
async function recordShort(page: Page, lang: 'en' | 'ru' = 'en') {
  await page.getByRole('button', { name: lang === 'ru' ? 'Начать запись' : 'Start recording', exact: true }).click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await page.waitForTimeout(5_500)
  await page.getByRole('button', { name: lang === 'ru' ? 'Завершить запись' : 'Finish recording', exact: true }).click()
}

async function captureCreditNotice(page: Page, lang: 'en' | 'ru') {
  if (!process.env.REVIEW_DIR) return
  mkdirSync(process.env.REVIEW_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.REVIEW_DIR, `${lang}-openrouter-problem-credits.png`) })
}

async function expectAlignedAiControls(page: Page) {
  const ids = ['ai-openrouter-key', 'ai-openrouter-transcriptionModel', 'ai-openrouter-textModel', 'ai-openrouter-transcriptionEffort', 'ai-openrouter-textEffort', 'ai-openrouter-dataPolicy']
  const lefts = await Promise.all(ids.map(id => page.locator(`#${id}`).evaluate(el => el.getBoundingClientRect().left)))
  expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(2)
  const labelWidth = await page.locator('.openrouter-key-row .settings-row-copy').evaluate(el => el.getBoundingClientRect().width)
  expect(labelWidth).toBeGreaterThanOrEqual(120)
}

test('OpenRouter first run saves defaults, offers restart, and transcribes a short recording', async () => {
  const fake = await startOpenRouterServer()
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-openrouter-first-run-'))
  let { app, page } = await launch(fake.url, userData)
  try {
    await configure(page)
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.getSize()[0] > 600) window.setSize(1280, 900) })
    await expectAlignedAiControls(page)
    await expect(page.getByTestId('openrouter-usage')).not.toContainText('$$')
    const keyRow = page.locator('.openrouter-key-row')
    await expect.poll(() => keyRow.locator('.settings-row-copy').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(120)
    await expect.poll(() => page.getByTestId('ai-openrouter-dataPolicy').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(380)
    await expect(page.getByTestId('ai-saved-pending')).toContainText('OpenRouter')
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.getSize()[0] > 600) window.setSize(720, 700) })
    await expectAlignedAiControls(page)
    ;({ app, page } = await relaunch(app, fake.url, userData))
    await recordShort(page)
    await expect.poll(() => fake.calls()).toBeGreaterThan(0)
    await page.getByRole('tab', { name: 'Transcript' }).click()
    await expect(page.getByTestId('transcript-text').filter({ hasText: 'Здравствуйте, проверка связи.' })).toHaveCount(2, { timeout: 60_000 })
  } finally { await app.close(); await fake.close() }
})

test('captures Russian OpenRouter model list at desktop and narrow widths', async () => {
  const fake = await startOpenRouterServer()
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-openrouter-review-'))
  const { app, page } = await launch(fake.url, userData, 'ru')
  try {
    mkdirSync(reviewEvidence, { recursive: true })
    await configure(page, 'ru')
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.getSize()[0] > 600) window.setSize(1280, 900) })
    await page.getByTestId('ai-openrouter-transcriptionModel').click()
    await expect(page.getByRole('option', { name: /Fake STT/ })).toBeVisible()
    await page.screenshot({ path: join(reviewEvidence, 'ru-openrouter-open-list-1280.png'), fullPage: true })
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.getSize()[0] > 600) window.setSize(720, 900) })
    await page.screenshot({ path: join(reviewEvidence, 'ru-openrouter-open-list-720.png'), fullPage: true })
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
    await captureCreditNotice(page, 'en')
    fake.setCredits(false)
    await page.getByTestId('note-transcript-retry').click()
    await page.getByRole('tab', { name: 'Transcript' }).click()
    await expect(page.getByTestId('transcript-text').filter({ hasText: 'Здравствуйте, проверка связи.' })).toHaveCount(2, { timeout: 60_000 })
  } finally { await app.close(); await fake.close() }
})

test('OpenRouter credits failure notice is clear in Russian', async () => {
  const fake = await startOpenRouterServer()
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-openrouter-credits-ru-'))
  let { app, page } = await launch(fake.url, userData, 'ru')
  try {
    await configure(page, 'ru')
    ;({ app, page } = await relaunch(app, fake.url, userData, 'ru'))
    fake.setCredits(true)
    await recordShort(page, 'ru')
    await expect.poll(() => fake.calls()).toBeGreaterThan(0)
    await expect(page.getByText(/На счёте OpenRouter закончились кредиты/)).toBeVisible({ timeout: 60_000 })
    await captureCreditNotice(page, 'ru')
    fake.setCredits(false)
    await page.getByTestId('note-transcript-retry').click()
    await page.getByRole('tab', { name: 'Расшифровка' }).click()
    await expect(page.getByTestId('transcript-text').filter({ hasText: 'Здравствуйте, проверка связи.' })).toHaveCount(2, { timeout: 60_000 })
  } finally { await app.close(); await fake.close() }
})
