import { _electron as electron, expect, test, tempDir } from './support/playwright'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
async function launch(extra: Record<string, string> = {}) {
  const userData = tempDir('ai-settings')
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_AI_BACKEND: '', YOGURT_USER_DATA: userData, ...extra } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}

test('provider recording explains the batched transcript before lines arrive', async () => {
  const { app, page } = await launch({ YOGURT_AI_BACKEND: 'agy', YOGURT_SYSTEM_LANGUAGES: 'ru-RU' })
  try {
    await page.getByRole('button', { name: 'Начать запись', exact: true }).click()
    await page.getByRole('tab', { name: 'Расшифровка' }).click()
    await expect(page.getByTestId('transcript-empty')).toContainText('Идёт запись. При работе через провайдера ИИ расшифровка появляется частями')
    await page.getByTestId('spoken-chip').click()
    await expect(page.getByTestId('spoken-multi')).toContainText('Язык определяется автоматически')
  } finally { await app.close() }
})

test('provider preferences save for the next launch and keep the current processing/privacy mode', async () => {
  const { app, page, userData } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('ai-backend')).toHaveValue('local')
    await page.getByTestId('ai-backend').selectOption('agy')
    await expect(page.getByTestId('ai-transcriptionModel')).toHaveValue('Gemini 3.8 Flash')
    await expect(page.getByTestId('ai-transcriptionModel-sub')).toContainText('gemini-3.8-flash')
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

test('a custom model ID can be picked with the keyboard and saved for the next launch', async () => {
  const { app, page, userData } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    await page.getByTestId('ai-backend').selectOption('agy')
    const model = page.getByTestId('ai-transcriptionModel')
    await model.click()
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.keyboard.type('claude-test-9')
    await page.getByRole('option', { name: /custom ID/ }).click()
    await expect(model).toHaveValue('claude-test-9')
    await expect(page.getByTestId('ai-transcriptionModel-sub')).toContainText('custom ID')
    await page.getByTestId('ai-save').click()
    const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).ai
    expect(saved).toMatchObject({ backend: 'agy', transcriptionModel: 'claude-test-9' })
    expect(await page.evaluate(() => window.yogurt.ai.get())).toMatchObject({ saved: { transcriptionModel: 'claude-test-9' }, restartRequired: true })
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
    const profile = page.getByTestId('ai-textProfile')
    await profile.click()
    await expect(profile).toHaveAttribute('aria-expanded', 'true')
    await profile.fill('!!!')
    await expect(page.getByText('IDs may contain Latin letters, digits and . - _ / :', { exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: /custom ID/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('ai-textProfile')).not.toHaveValue('!!!')
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
