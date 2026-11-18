import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-ai-settings-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_AI_BACKEND: '', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}

test('provider preferences save for the next launch and keep the current processing/privacy mode', async () => {
  const { app, page, userData } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('ai-backend')).toHaveValue('local')
    await page.getByTestId('ai-backend').selectOption('agy')
    await expect(page.getByTestId('ai-transcriptionModel')).toHaveValue('gemini-3.8-flash')
    await expect(page.getByTestId('ai-transcriptionEffort')).toHaveValue('medium')
    await page.getByTestId('ai-outputLanguage').selectOption('ru')
    await page.getByTestId('ai-save').click()
    await expect(page.getByTestId('ai-saved-pending')).toBeVisible()
    await expect(page.getByTestId('ai-active')).toContainText('Local models')
    await expect(page.getByTestId('settings-ai-privacy')).toContainText(/stay on this (Mac|computer)/)
    const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).ai
    expect(saved).toMatchObject({ backend: 'agy', transcriptionModel: 'gemini-3.8-flash', textEffort: 'medium', outputLanguage: 'ru' })
    expect(await page.evaluate(() => window.yogurt.ai.get())).toMatchObject({ active: { backend: 'local' }, restartRequired: true })
    await expect(page.getByTestId('ai-save')).toBeDisabled()
  } finally { await app.close() }
})

test('checks an unsaved missing executable without changing settings, and validates profile fields', async () => {
  const { app, page, userData } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    await page.getByTestId('ai-backend').selectOption('agy')
    await page.getByTestId('ai-advanced').locator('summary').click()
    await page.getByTestId('ai-agyPath').fill(join(userData, 'missing-agy-executable'))
    await page.getByTestId('ai-check').click()
    await expect(page.getByTestId('ai-check-result')).toHaveAttribute('data-error', 'true')
    expect(await page.evaluate(() => window.yogurt.ai.get())).toMatchObject({ saved: { backend: 'local' }, active: { backend: 'local' }, restartRequired: false })
    await page.getByTestId('ai-backend').selectOption('porch')
    await expect(page.getByTestId('ai-textProfile')).toBeVisible()
    await expect(page.getByTestId('ai-textModel')).toHaveCount(0)
    await page.getByTestId('ai-textProfile').fill('')
    await expect(page.getByTestId('ai-save')).toBeDisabled()
  } finally { await app.close() }
})

test('a saved provider change cannot restart an active recording', async () => {
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('settings-open').click()
    await page.getByTestId('ai-backend').selectOption('agy')
    await page.getByTestId('ai-save').click()
    await page.getByTestId('ai-restart').click()
    await expect(page.getByTestId('ai-notice')).toContainText('Finish recording')
    expect(await page.evaluate(() => window.yogurt.ai.get())).toMatchObject({ active: { backend: 'local' }, restartRequired: true })
  } finally { await app.close() }
})
