import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const evidence = '/Users/rodio/.local/state/coordinator-mode/journals/yogurt-a940b5b7/evidence/cli-problems'
const recoveryEvidence = '/Users/rodio/.local/state/coordinator-mode/journals/yogurt-a940b5b7/evidence/batch-reject/screens'
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

async function launch(locale: 'en' | 'ru', failure: 'cli-failed' | 'cli-missing' | 'bad-output' | 'bad-output-once', backend: 'agy' | 'porch' = 'agy') {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-cli-problems-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ language: locale, ai: { backend } }))
  const app = await electron.launch({ args: [main], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_AI_BACKEND: '', YOGURT_FAKE_CLI_FAILURE: failure,
    ...(backend === 'porch' ? { YOGURT_PORCH_PATH: join(userData, 'missing-fake-porch') } : {}),
    YOGURT_SYSTEM_LANGUAGES: locale, YOGURT_USER_DATA: userData,
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}
const capture = async (page: Page, name: string) => page.screenshot({ path: join(evidence, name), fullPage: true })

for (const locale of ['en', 'ru'] as const) test(`${locale}: CLI failures explain Retry and recover the stopped transcript`, async () => {
  mkdirSync(evidence, { recursive: true })
  const { app, page } = await launch(locale, 'cli-failed')
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('note-transcript-pending')).toHaveCount(0)
    const noteNotice = page.getByTestId('rec-hint')
    await expect(noteNotice).toContainText(locale === 'en' ? 'Yogurt will try again automatically after the meeting.' : 'после встречи Yogurt попробует ещё раз автоматически.', { timeout: 30_000 })
    await capture(page, `${locale}-a-live-note-cli-failed.png`)
    if (locale === 'ru') {
      mkdirSync(recoveryEvidence, { recursive: true })
      await page.screenshot({ path: join(recoveryEvidence, 'ru-live-transcript-auto.png'), fullPage: true })
    }

    const widget = await windowOf(app, '#widget')
    await expect(widget.getByTestId('widget-note')).toBeVisible()
    await expect(widget.getByTestId('widget-note')).toContainText(locale === 'en' ? 'try again automatically after the meeting' : 'после встречи Yogurt попробует ещё раз автоматически.')
    await capture(widget, `${locale}-b-widget-cli-failed.png`)

    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-transcript-pending')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('note-transcript-pending')).toContainText(locale === 'en' ? 'when it opens again' : 'при следующем запуске')
    await expect(noteNotice).toContainText(locale === 'en' ? 'couldn’t process this part' : 'не смог обработать эту часть')
    await expect(noteNotice).toContainText(locale === 'en' ? 'Your audio is kept.' : 'Аудио сохранено.')
    await expect(noteNotice).not.toContainText(locale === 'en' ? /after the meeting|retry/i : /после встречи|повторить|автоматически/iu)
    if (locale === 'ru') {
      mkdirSync(recoveryEvidence, { recursive: true })
      await page.screenshot({ path: join(recoveryEvidence, 'ru-pending-transcript-auto.png'), fullPage: true })
    }
    await capture(page, `${locale}-d-after-stop-retry-banner.png`)

    // Give the provisional summary something to preserve before recovery adds transcript lines.
    if (locale === 'ru') {
      const id = await page.evaluate(async () => (await window.yogurt.nav.current()).slice('/note/'.length))
      await page.evaluate(async id => window.yogurt.notes.setMine(id, 'Заметки владельца для неполной расшифровки.', 1), id)
      await page.evaluate(async id => window.yogurt.notes.writeAgain(id), id)
      await expect(page.getByTestId('note-summary-tab')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
      const manualSummary = 'Ручная правка: сохранить без изменений.'
      const editor = page.getByTestId('note-enhanced-editor')
      await editor.fill(manualSummary)
      await editor.press('Tab')
      await expect.poll(() => page.evaluate(async id => {
        const note = await window.yogurt.notes.get(id)
        return note?.edited === true && note.enhanced?.includes('Ручная правка: сохранить без изменений.')
      }, id)).toBe(true)
    }

    await fake(app, 'cliFailure')
    await page.getByTestId('note-transcript-retry').click()
    await expect(page.getByTestId('note-transcript-pending')).toHaveCount(0, { timeout: 30_000 })
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'Retry recovered this transcript.' }).first()).toBeVisible({ timeout: 30_000 })
    if (locale === 'ru') {
      await expect(page.getByTestId('note-transcript-added')).toContainText('Ваши изменения в заметках сохранены.')
      const summaryTab = page.getByTestId('note-summary-tab')
      await summaryTab.click()
      await expect(summaryTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByTestId('note-enhanced-editor')).toContainText('Ручная правка: сохранить без изменений.')
      await page.screenshot({ path: join(recoveryEvidence, 'ru-transcript-added-edited.png'), fullPage: true })
    }
    await capture(page, `${locale}-e-retry-recovered.png`)
  } finally { await app.close() }

  const missing = await launch(locale, 'cli-missing')
  try {
    await fake(missing.app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(missing.app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(missing.page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(missing.page.getByTestId('rec-hint')).toContainText(locale === 'en' ? 'After the meeting, press Retry in the note.' : 'После встречи нажмите Повторить в заметке.', { timeout: 30_000 })
    await capture(missing.page, `${locale}-c-cli-missing.png`)
  } finally { await missing.app.close() }
})

test('Russian: a malformed transcript shows the output-specific notice while recording', async () => {
  mkdirSync(recoveryEvidence, { recursive: true })
  const { app, page } = await launch('ru', 'bad-output')
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const notice = page.getByTestId('rec-hint')
    await expect(notice).toContainText('Модель вернула расшифровку, которую Yogurt не смог прочитать.', { timeout: 30_000 })
    await expect(notice).toContainText('Аудио сохранено')
    await page.screenshot({ path: join(recoveryEvidence, 'ru-live-transcript-output.png'), fullPage: true })
  } finally { await app.close() }
})

test('Russian: one malformed model output is retried and notes follow the completed transcript automatically', async () => {
  mkdirSync(recoveryEvidence, { recursive: true })
  const { app, page } = await launch('ru', 'bad-output-once')
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.waitForTimeout(5_500)
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-transcript-pending')).toHaveCount(0, { timeout: 60_000 })
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'Bad output recovered automatically.' }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('note-transcript-toggle')).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: join(recoveryEvidence, 'ru-bad-output-recovered.png'), fullPage: true })
    const summaryTab = page.getByTestId('note-summary-tab')
    await expect(summaryTab).toBeVisible({ timeout: 60_000 })
    await summaryTab.click()
    await expect(summaryTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    await expect(page.getByTestId('note-enhanced-editor')).not.toBeEmpty()
  } finally { await app.close() }
})

test('Russian Porch settings show the failed catalog and identify the shipped profile as default', async () => {
  mkdirSync(evidence, { recursive: true })
  const { app, page } = await launch('ru', 'cli-failed', 'porch')
  try {
    await page.getByTestId('settings-open').click()
    await expect(page.getByText('Не удалось загрузить профили Porch. Можно указать свой ID профиля.')).toBeVisible()
    await expect(page.getByTestId('ai-textProfile-sub')).toContainText('по умолчанию')
    await expect(page.getByTestId('ai-textProfile-sub')).not.toContainText('свой ID')
    await page.getByTestId('ai-textProfile').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, 'ru-porch-failed-list.png') })
  } finally { await app.close() }
})
