import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(userData = mkdtempSync(join(tmpdir(), 'yogurt-spoken-'))) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const languages = async (app: ElectronApplication) => (await fake<{ languages: string[] }>(app, 'prompts')).languages
const saved = (userData: string) => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).spoken

test('the spoken language picker: Multi-language by default, explicit choices are remembered and shown in Settings', async () => {
  const a = await launch()
  const { app, page } = a
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('spoken-name')).toHaveText('Multi-language')
    // whisper detects the language automatically
    await expect.poll(async () => (await languages(app)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(new Set(await languages(app))).toEqual(new Set(['auto']))

    await page.getByTestId('spoken-chip').click()
    const menu = page.getByTestId('spoken-menu')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('spoken-en')).toContainText('English only')
    await expect(page.getByTestId('spoken-en')).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('spoken-ru')).toContainText('Russian')
    await expect(page.getByTestId('spoken-ru')).toContainText('Transcribes Russian in Cyrillic')
    await expect(page.getByTestId('spoken-multi')).toContainText('Multi-language')
    await expect(page.getByTestId('spoken-multi')).toContainText('99 languages supported')
    await expect(page.getByTestId('spoken-multi')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('spoken-multi-info')).toHaveAttribute('title', /automatically/)

    // Explicit Russian reaches transcription immediately and is retained by the settings IPC.
    const beforeRussian = (await languages(app)).length
    await page.getByTestId('spoken-ru').click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('spoken-name')).toHaveText('Russian')
    await expect.poll(() => saved(a.userData)).toBe('ru')
    await expect.poll(async () => (await languages(app)).slice(beforeRussian), { timeout: 30_000 }).toContain('ru')
    await page.getByTestId('spoken-chip').click()
    await expect(page.getByTestId('spoken-ru')).toHaveAttribute('aria-checked', 'true')

    // the recording going on detects from its next words, and the choice is kept for the next ones
    const told = (await languages(app)).length
    await page.getByTestId('spoken-multi').click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('spoken-name')).toHaveText('Multi-language')
    await expect.poll(() => saved(a.userData)).toBe('multi')
    await expect.poll(async () => (await languages(app)).slice(told), { timeout: 30_000 }).toContain('auto')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')

    // the keyboard: Escape closes, the checked one has focus when it opens
    await page.getByTestId('spoken-chip').click()
    // (a hidden test window never has focus itself, so the element is read instead)
    const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)
    await expect.poll(focused).toBe('spoken-multi')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // Settings → Language shows the same choice, and changes it back
    await page.getByTestId('note-stop').click()
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-spoken-multi')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('settings-spoken-en').click()
    await expect(page.getByTestId('settings-spoken-en')).toHaveAttribute('aria-checked', 'true')
    // An explicit English choice is written down even though older profiles defaulted to English.
    await expect.poll(() => saved(a.userData)).toBe('en')
    await page.getByTestId('settings-spoken-en').press('ArrowRight')
    await expect(page.getByTestId('settings-spoken-ru')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(focused).toBe('settings-spoken-ru')
    await expect.poll(() => saved(a.userData)).toBe('ru')
    await page.getByTestId('settings-spoken-ru').press('ArrowRight')
    await expect(page.getByTestId('settings-spoken-multi')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(focused).toBe('settings-spoken-multi')
    await expect.poll(() => saved(a.userData)).toBe('multi')
    await page.getByTestId('settings-spoken-multi').press('ArrowLeft')
    await expect(page.getByTestId('settings-spoken-ru')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => saved(a.userData)).toBe('ru')
  } finally { await app.close() }

  // After a relaunch the next recording starts in Russian while the interface stays English.
  const b = await launch(a.userData)
  try {
    await b.page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(b.page.getByTestId('spoken-name')).toHaveText('Russian')
    await expect.poll(async () => (await languages(b.app)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(new Set(await languages(b.app))).toEqual(new Set(['ru']))
  } finally { await b.app.close() }
})

test('a legacy profile without spoken language upgrades to explicit English once', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-spoken-legacy-'))
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ myName: 'Ari' }))
  const { app } = await launch(userData)
  try {
    await expect.poll(() => saved(userData)).toBe('en')
    const profile = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
    expect(profile).toMatchObject({ myName: 'Ari', spoken: 'en', spokenMigrated: 2 })
  } finally { await app.close() }
})
