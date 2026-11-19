import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { aiSettings, type AiBackend, type AiPreferences } from '../src/shared/ai'
import { setLanguage } from '../src/shared/i18n'
import { AiSettingsFields, AiStatus } from '../src/renderer/src/components/AiSettings'
import { aiProblemText, aiText, aiRussianCopy } from '../src/renderer/src/components/aiCopy'
import { screenCopy } from '../src/renderer/src/permissionCopy'
import { setupItems } from '../src/renderer/src/components/SetupStatus'
import { spokenSupportText } from '../src/renderer/src/components/SpokenMenu'

const fields = (backend: AiBackend) => renderToStaticMarkup(createElement(AiSettingsFields, { value: aiSettings({ backend }), change() {} }))
const prefs = (partial: Partial<AiPreferences>): AiPreferences => ({ saved: aiSettings({}), active: aiSettings({}), restartRequired: false, ...partial })
const status = (preferences: AiPreferences, dirty = false) =>
  renderToStaticMarkup(createElement(AiStatus, { preferences, busy: null, dirty, restart() {} }))
afterEach(() => setLanguage('en'))

describe('AI settings fields', () => {
  it('offers independent audio/text models and medium effort for direct agy', () => {
    const html = fields('agy')
    expect(html).toContain('id="ai-transcriptionModel"')
    expect(html).toContain('id="ai-textModel"')
    // the picker's closed field shows the model label; the exact ID stays in the fact line below it
    const input = (id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? ''
    expect(input('ai-transcriptionModel')).toContain('role="combobox"')
    expect(input('ai-transcriptionModel')).toContain('value="Gemini 3.8 Flash"')
    expect(input('ai-textModel')).toContain('value="Gemini 3.8 Flash"')
    expect(html.match(/model-picker-summary-id[^>]*>gemini-3\.8-flash/g)).toHaveLength(2)
    expect(html).not.toContain('gemini-3.8-flash · audio · verified')
    const textFacts = html.match(/<div class="model-picker-sub" data-testid="ai-textModel-sub">([\s\S]*?)<\/div>/)?.[1] ?? ''
    expect(textFacts).not.toContain('аудио')
    expect(html.match(/value="medium" selected=""/g)).toHaveLength(2)
    expect(html).not.toContain('id="ai-textProfile"')
    expect(html).toContain('id="ai-agyPath"')
    expect(html).toContain('No shell commands or extra arguments')
  })

  it('offers only medium and high for transcription effort while text keeps low', () => {
    const html = fields('agy')
    const select = (id: string) => html.match(new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`))?.[0] ?? ''
    const transcription = select('ai-transcriptionEffort'), text = select('ai-textEffort')
    expect(transcription).toContain('value="medium"')
    expect(transcription).toContain('value="high"')
    expect(transcription).not.toContain('value="low"')
    expect(text).toContain('value="low"')
    expect(text).toContain('value="medium"')
    expect(text).toContain('value="high"')
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
    expect(html).toContain('Choose one exact Porch profile backed by agy.')
    expect(html).toContain('The selected profile sets the model and thinking level for text.')
    expect(html).toContain('Transcription model override')
    const advanced = html.slice(html.indexOf('<details'))
    expect(advanced).toContain('id="ai-transcriptionModel"')
  })

  it('does not expose irrelevant executable controls for local models', () => {
    const html = fields('local')
    expect(html).not.toContain('id="ai-agyPath"')
    expect(html).not.toContain('id="ai-transcriptionModel"')
    expect(html).toContain('downloads speech, notes and search models after restart')
    expect(html).not.toContain('id="ai-outputLanguage"')
  })

  it('labels an OpenRouter locked backend and summarizes its OpenRouter transcription model', () => {
    const locked = { backend: { variable: 'YOGURT_AI_BACKEND', value: 'openrouter' } }
    const html = renderToStaticMarkup(createElement(AiSettingsFields, { value: aiSettings({ backend: 'openrouter' }), change() {}, locked }))
    expect(html).toContain('ai-openrouter-transcriptionModel')
    expect(html).toContain('Same model for summaries and questions')
    expect(html).not.toContain('id="ai-transcriptionModel"')
    expect(html).not.toContain('id="ai-transcriptionEffort"')
    expect(status(prefs({ active: aiSettings({ backend: 'openrouter' }) }))).toContain('OpenRouter · google/gemini-3.8-flash')
  })

  it('locks an environment-provided OpenRouter key and reveals only its tail', () => {
    const html = renderToStaticMarkup(createElement(AiSettingsFields, { value: aiSettings({ backend: 'openrouter' }), change() {}, locked: {
      openrouterKey: { variable: 'YOGURT_OPENROUTER_API_KEY', value: '789a' },
    } }))
    expect(html).toContain('Set at launch by YOGURT_OPENROUTER_API_KEY. It can&#x27;t be changed here.')
    expect(html).toContain('sk-or-v1-••••••••')
    expect(html).toContain('readOnly=""')
    expect(html).not.toContain('789a')
  })

  it('hides the inactive local output-language override without changing the saved provider value', () => {
    const saved = aiSettings({ backend: 'local', outputLanguage: 'ru' })
    const html = renderToStaticMarkup(createElement(AiSettingsFields, { value: saved, change() {} }))
    expect(html).not.toContain('ai-outputLanguage')
    expect(saved.outputLanguage).toBe('ru')
    const provider = { ...saved, backend: 'agy' as const }
    expect(renderToStaticMarkup(createElement(AiSettingsFields, { value: provider, change() {} }))).toContain('value="ru" selected=""')
  })

  it('shows the status line as one line of what runs now, with the mode and its model', () => {
    expect(status(prefs({}))).toContain('Active now:</strong> agy · Antigravity CLI · gemini-3.8-flash')
    expect(status(prefs({ active: aiSettings({ backend: 'local' }) }))).toContain('Local models')
    setLanguage('ru')
    expect(status(prefs({}))).toContain('Сейчас работает')
  })

  it('locks a launch-variable mode to the effective value, disabled, naming the variable in both UI languages', () => {
    const saved = aiSettings({ backend: 'porch' })
    const locked = { backend: { variable: 'YOGURT_AI_BACKEND', value: 'agy' } }
    const render = () => renderToStaticMarkup(createElement(AiSettingsFields, { value: saved, change() {}, locked }))
    const html = render()
    // the effective mode is shown instead of the stored Porch choice, and cannot be edited
    expect(html).toContain('value="agy" selected=""')
    expect(html).not.toContain('value="porch" selected=""')
    expect(html.match(/<select[^>]*id="ai-backend"[^>]*>/)?.[0]).toContain('disabled=""')
    expect(html).toContain('Set at launch by YOGURT_AI_BACKEND. It can&#x27;t be changed here.')
    // fields below follow the effective agy mode, not the stored Porch one
    expect(html).toContain('id="ai-textModel"')
    expect(html).not.toContain('id="ai-textProfile"')
    setLanguage('ru')
    expect(render()).toContain('Задано при запуске переменной YOGURT_AI_BACKEND')
  })

  it('locks an executable path fixed by a launch variable while other fields stay editable', () => {
    const locked = { agyPath: { variable: 'YOGURT_AGY_PATH', value: '/opt/provider/agy' } }
    const html = renderToStaticMarkup(createElement(AiSettingsFields, { value: aiSettings({ backend: 'agy' }), change() {}, locked }))
    const input = html.match(/<input[^>]*id="ai-agyPath"[^>]*>/)?.[0] ?? ''
    expect(input).toContain('disabled=""')
    expect(input).toContain('value="/opt/provider/agy"')
    expect(html).toContain('Set at launch by YOGURT_AGY_PATH.')
    expect(html.match(/<input[^>]*id="ai-transcriptionModel"[^>]*>/)?.[0]).not.toContain('disabled')
  })

  it('adds a saved line with a restart button only while a different saved mode waits for restart', () => {
    const pending = prefs({ saved: aiSettings({ backend: 'local' }), active: aiSettings({ backend: 'agy' }), restartRequired: true })
    const html = status(pending)
    expect(html).toContain('Saved: Local models — applies after restart.')
    expect(html).toContain('data-testid="ai-saved-pending"')
    expect(html).toContain('data-testid="ai-restart"')
    expect(status(pending, true).match(/data-testid="ai-restart"[^>]*/)?.[0]).toContain('disabled=""')
    // same configuration: one line, no restart offer; a locked field: the variable explains it instead
    expect(status(prefs({}))).not.toContain('ai-saved-pending')
    expect(status(prefs({ ...pending, locked: { backend: { variable: 'YOGURT_AI_BACKEND', value: 'agy' } } }))).not.toContain('ai-saved-pending')
    setLanguage('ru')
    expect(status(pending)).toContain('Сохранено: Локальные модели — применится после перезапуска.')
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
    expect(fields('agy')).toContain('Средний')
    expect(aiText('checkHelp')).toContain('не обращается к модели')
    expect(aiText('title', 'de')).toBe(aiText('title', 'en'))
  })

  it('uses provider-specific help text for automatic spoken-language detection', () => {
    expect(spokenSupportText('local')).toContain('99 languages supported')
    expect(spokenSupportText('agy')).toBe('Language is detected automatically')
    setLanguage('ru')
    expect(spokenSupportText('local')).toContain('99 языков')
    expect(spokenSupportText('porch')).toBe('Язык определяется автоматически')
  })

  it('shows actionable remote transcription problems in Russian and English across locale fallback', () => {
    expect(aiProblemText('credits', undefined, 'en')).toContain('Add credits')
    expect(aiProblemText('credits', undefined, 'en')).toContain('Yogurt will continue by itself')
    expect(aiProblemText('no-key', undefined, 'ru')).toContain('Добавьте API-ключ OpenRouter')
    expect(aiProblemText('model-gone', 'vendor/model', 'ru')).toContain('vendor/model')
    expect(aiProblemText('auth', undefined, 'de')).toContain('OpenRouter rejected the key')
  })

  it('explains that unreadable saved audio was not deleted and offers Retry', () => {
    expect(aiProblemText('local-audio', undefined, 'en')).toBe("Yogurt couldn't read the saved audio for this part. The file was not deleted. Press Retry to try again.")
    expect(aiProblemText('local-audio', undefined, 'ru')).toBe('Yogurt не смог прочитать сохранённое аудио этой части. Файл не удалён. Нажмите кнопку Повторить.')
  })
})

it('keeps Russian AI copy free of unapproved Latin words', () => {
  const allowed = new Set(['Yogurt', 'OpenRouter', 'agy', 'Antigravity', 'Porch', 'Gemini', 'Flash', 'macOS', 'Mac', 'API', 'ID', 'CLI', 'ZDR', 'STT', 'PATH'].map(word => word.toLocaleLowerCase()))
  const words = Object.values(aiRussianCopy).flatMap(value => value.replace(/\{[^}]*\}/g, '').replace(/openrouter\.ai/gi, '').match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) ?? [])
  expect([...new Set(words.filter(word => !allowed.has(word.toLocaleLowerCase())))]).toEqual([])
})

it('shows actionable CLI transcription problems in Russian and English', () => {
  const retryEn = 'After the meeting, press Retry in the note.'
  const retryRu = 'После встречи нажмите Повторить в заметке.'
  for (const code of ['cli-missing', 'cli-failed', 'cli-config', 'timeout', 'bad-response'] as const) {
    expect(aiProblemText(code, undefined, 'en', 'agy')).toContain(retryEn)
    expect(aiProblemText(code, undefined, 'ru', 'agy')).toContain(retryRu)
    expect(aiProblemText(code, undefined, 'en', 'agy')).toContain('Your audio is kept.')
    expect(aiProblemText(code, undefined, 'ru', 'agy')).toContain('Аудио сохранено.')
    expect(aiProblemText(code, undefined, 'en', 'agy', true)).not.toContain(retryEn)
    expect(aiProblemText(code, undefined, 'ru', 'agy', true)).not.toContain(retryRu)
    expect(aiProblemText(code, undefined, 'en', 'agy', true)).toMatch(/Your audio is kept\.$/)
    expect(aiProblemText(code, undefined, 'ru', 'agy', true)).toMatch(/Аудио сохранено\.$/)
  }
  expect(aiProblemText('cli-missing', undefined, 'en', 'agy')).toContain('couldn’t start agy')
  expect(aiProblemText('cli-missing', undefined, 'ru', 'agy')).toContain('не смог запустить agy')
  expect(aiProblemText('cli-failed', undefined, 'ru', 'Porch')).toContain('Porch не смог обработать эту часть')
  expect(aiProblemText('timeout', undefined, 'en', 'agy')).toContain('increase the timeout')
  expect(aiProblemText('bad-response', undefined, 'ru', 'Porch')).toContain('вернул ответ')
  expect(aiProblemText('cli-config', undefined, 'ru', 'Porch')).toContain('профиль Porch')
  expect(aiProblemText('cli-failed', undefined, 'ru', 'Porch')).not.toContain('«')
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
