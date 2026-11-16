import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { aiSettings, type AiBackend } from '../src/shared/ai'
import { setLanguage } from '../src/shared/i18n'
import { AiActiveSettings, AiEnvironmentNotice, AiSettingsFields } from '../src/renderer/src/components/AiSettings'
import { aiText } from '../src/renderer/src/components/aiCopy'
import { screenCopy } from '../src/renderer/src/permissionCopy'
import { setupItems } from '../src/renderer/src/components/SetupStatus'

const fields = (backend: AiBackend) => renderToStaticMarkup(createElement(AiSettingsFields, { value: aiSettings({ backend }), change() {} }))
afterEach(() => setLanguage('en'))

describe('AI settings fields', () => {
  it('offers independent audio/text models and medium effort for direct agy', () => {
    const html = fields('agy')
    expect(html).toContain('id="ai-transcriptionModel"')
    expect(html).toContain('id="ai-textModel"')
    expect(html.match(/value="gemini-3\.8-flash"/g)).toHaveLength(2)
    expect(html.match(/value="medium" selected=""/g)).toHaveLength(2)
    expect(html).not.toContain('id="ai-textProfile"')
    expect(html).toContain('id="ai-agyPath"')
    expect(html).toContain('No shell commands or extra arguments')
  })

  it('keeps Porch profile text settings distinct from the agy audio override', () => {
    const html = fields('porch')
    expect(html).toContain('id="ai-transcriptionProfile"')
    expect(html).toContain('id="ai-textProfile"')
    expect(html).toContain('id="ai-transcriptionModel"')
    expect(html).toContain('id="ai-transcriptionEffort"')
    expect(html).not.toContain('id="ai-textModel"')
    expect(html).not.toContain('id="ai-textEffort"')
    expect(html).toContain('id="ai-porchPath"')
    expect(html).toContain('one exact Porch profile ID backed by agy')
  })

  it('does not expose irrelevant executable controls for local models', () => {
    const html = fields('local')
    expect(html).not.toContain('id="ai-agyPath"')
    expect(html).not.toContain('id="ai-transcriptionModel"')
    expect(html).toContain('downloads speech, notes and search models after restart')
    expect(html).not.toContain('id="ai-outputLanguage"')
  })

  it('hides the inactive local output-language override without changing the saved provider value', () => {
    const saved = aiSettings({ backend: 'local', outputLanguage: 'ru' })
    const html = renderToStaticMarkup(createElement(AiSettingsFields, { value: saved, change() {} }))
    expect(html).not.toContain('ai-outputLanguage')
    expect(renderToStaticMarkup(createElement(AiActiveSettings, { active: saved }))).not.toContain('AI output language')
    expect(saved.outputLanguage).toBe('ru')
    const provider = { ...saved, backend: 'agy' as const }
    expect(renderToStaticMarkup(createElement(AiSettingsFields, { value: provider, change() {} }))).toContain('value="ru" selected=""')
    expect(renderToStaticMarkup(createElement(AiActiveSettings, { active: provider }))).toContain('AI output language')
  })

  it('names environment-controlled fields and variables in both supported UI languages', () => {
    const overrides = ['YOGURT_AI_BACKEND', 'YOGURT_AGY_PATH', 'YOGURT_PORCH_PATH'] as const
    const render = () => renderToStaticMarkup(createElement(AiEnvironmentNotice, { overrides: [...overrides] }))
    const en = render()
    expect(en).toContain('still take precedence after restart')
    expect(en).toContain('Processing mode (YOGURT_AI_BACKEND)')
    expect(en).toContain('agy executable (YOGURT_AGY_PATH)')
    expect(en).toContain('Porch executable (YOGURT_PORCH_PATH)')
    setLanguage('ru')
    expect(render()).toContain('приоритет и после перезапуска')
    expect(render()).toContain('Режим обработки (YOGURT_AI_BACKEND)')
    expect(renderToStaticMarkup(createElement(AiEnvironmentNotice, { overrides: undefined }))).toBe('')
  })

  it('associates field labels and descriptions and sets bounded whole-number limits', () => {
    const html = fields('agy')
    for (const id of ['ai-backend', 'ai-transcriptionModel', 'ai-transcriptionEffort', 'ai-textModel', 'ai-textEffort', 'ai-outputLanguage', 'ai-agyPath', 'ai-timeoutSeconds', 'ai-contextTokens']) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toContain('aria-describedby="ai-outputLanguage-help"')
    expect(html).toContain('min="10" max="1800"')
    expect(html).toContain('min="8192" max="1048576"')
    expect(html).not.toMatch(/type="password"/)
  })

  it('shows Russian provider controls and documents English fallback for other locales', () => {
    setLanguage('ru')
    expect(fields('agy')).toContain('Модель расшифровки')
    expect(fields('agy')).toContain('Средний · medium')
    expect(aiText('checkHelp')).toContain('не обращается к модели')
    expect(aiText('title', 'de')).toBe(aiText('title', 'en'))
  })
})

describe('provider-aware onboarding privacy', () => {
  it('keeps the original local promise only in local mode', () => {
    expect(screenCopy('welcome', false).text).toContain('nothing leaves your Mac')
    expect(screenCopy('welcome', true).text).toContain('AI providers')
    expect(screenCopy('welcome', true).text).not.toContain('nothing leaves')
    expect(screenCopy('ready', true).text).toContain('without downloading local AI models')
    expect(setupItems({ phase: 'checking', fraction: 0 }, true)[0].text).not.toContain('Everything stays')
    expect(setupItems({ phase: 'ready', fraction: 1 }, true)[0]).toMatchObject({ id: 'provider', done: true })
  })

  it('explains remote processing in Russian as well', () => {
    setLanguage('ru')
    expect(screenCopy('welcome', true).text).toContain('провайдеры ИИ')
    expect(aiText('privacySubscription')).toContain('отправляются выбранным провайдерам')
  })
})
