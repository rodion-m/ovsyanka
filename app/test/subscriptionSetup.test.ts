import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_SETTINGS, aiSettings, validAiSettings } from '../src/shared/ai'
import { configuredAi } from '../src/main/settings'
import { SetupController } from '../src/main/setup'
import { keywordOnlyEmbedder } from '../src/main/library/embedder'

describe('subscription startup', () => {
  it('reaches ready without hardware probes, downloads, disk checks, or local model paths, including retry', async () => {
    const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Local model work must not run') })
    const setup = new SetupController({
      subscription: true, modelsDir: '/unused', getHardware: forbidden, getCatalog: forbidden,
      download: { download: forbidden, hashFile: forbidden, freeDiskGB: forbidden },
      speed: { measure: forbidden, load: () => { throw new Error('No speed check') }, save: () => { throw new Error('No speed check') } },
    })
    await setup.start()
    await setup.idle()
    await setup.retry()
    await setup.downloadUpgrade()
    await setup.skipUpgrade()
    await setup.removeUpgrade(async remove => remove())
    expect(setup.state).toEqual({ phase: 'ready', fraction: 1 })
    expect(setup.installed()).toBeUndefined()
    expect(setup.notesPath()).toBeUndefined()
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('makes keyword retrieval available without pretending to have an embedding model', async () => {
    const embedder = keywordOnlyEmbedder()
    expect(embedder.ready()).toBe(false)
    expect(await embedder.query('Что решили на встрече?')).toBeUndefined()
    expect(await embedder.docs([{ title: 'План запуска', text: 'Запуск перенесли на пятницу.' }])).toBeUndefined()
    await expect(embedder.unload()).resolves.toBeUndefined()
  })
})

describe('AI configuration', () => {
  it('selects the requested Gemini family and medium effort without API keys', () => {
    expect(configuredAi({}, {})).toEqual(DEFAULT_AI_SETTINGS)
    expect(aiSettings(undefined)).toMatchObject({ backend: 'agy', transcriptionModel: 'gemini-3.8-flash', transcriptionEffort: 'medium' })
  })

  it('never allows low effort for transcription while text keeps it', () => {
    expect(aiSettings({ transcriptionEffort: 'low' }).transcriptionEffort).toBe('medium')
    expect(aiSettings({ transcriptionEffort: 'high' }).transcriptionEffort).toBe('high')
    expect(aiSettings({ transcriptionEffort: 'extreme' }).transcriptionEffort).toBe('medium')
    expect(aiSettings({ textEffort: 'low' }).textEffort).toBe('low')
  })

  it('keeps upstream fake fixtures local and honors an explicitly selected subscription backend', () => {
    expect(configuredAi({}, {}, true).backend).toBe('local')
    expect(configuredAi({ ai: aiSettings({ backend: 'porch' }) }, {}, true).backend).toBe('porch')
    expect(configuredAi({}, { YOGURT_AI_BACKEND: 'agy', YOGURT_AGY_PATH: '/Applications/AI CLI/agy' }, true)).toMatchObject({ backend: 'agy', agyPath: '/Applications/AI CLI/agy' })
    expect(() => configuredAi({}, { YOGURT_AI_BACKEND: 'typo' })).toThrow('YOGURT_AI_BACKEND')
  })

  it('validates limits and an exact single Porch profile, including IPC extra fields', () => {
    const good = aiSettings({ backend: 'porch', textProfile: 'claude-sonnet', outputLanguage: 'ru' })
    expect(validAiSettings(good)).toBe(true)
    for (const value of [
      { ...good, textProfile: '*' }, { ...good, textProfile: 'codex,claude' },
      { ...good, textProfile: '--all' }, { ...good, timeoutSeconds: Infinity },
      { ...good, contextTokens: 1 }, { ...good, agyPath: 'agy\nextra' },
      { ...good, constructor: 'bad' }, { ...good, toString: 'bad' },
    ]) expect(validAiSettings(value)).toBe(false)
  })
})
