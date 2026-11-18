import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aiSettings, type AiPreferences, type AiSettings } from '../src/shared/ai'
import { configuredAi, loadSettings, updateSettings } from '../src/main/settings'
import { hookAiPreferences } from '../src/main/harness/ipc'
import { checkHarness } from '../src/main/harness/index'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } }))
vi.mock('../src/main/harness/index', () => ({ checkHarness: vi.fn(async () => ({ ok: true, message: 'agy 1.5.4' })) }))
const call = <T = unknown>(name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args) as T

let dir: string, file: string, active: AiSettings
const restart = vi.fn(() => true)
const check = vi.fn(async (_settings: AiSettings) => ({ ok: true, message: 'Available executable' }))
beforeEach(() => {
  handlers.clear(); vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'yogurt-ai-preferences-'))
  file = join(dir, 'settings.json')
  active = aiSettings({ backend: 'local' })
  hookAiPreferences({ file, active, restart, check, env: {} })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('AI preferences IPC', () => {
  it('uses the active launch default for an unsaved profile without writing or checking anything', () => {
    expect(call('ai:get')).toEqual({ saved: active, active, restartRequired: false })
    expect(existsSync(file)).toBe(false)
    expect(check).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('persists provider changes alongside existing settings and applies them only on a later launch', () => {
    updateSettings(file, { language: 'ru', theme: 'dark' })
    const next = aiSettings({ backend: 'porch', transcriptionProfile: 'agy-gemini-3.8-flash', textProfile: 'claude-sonnet', outputLanguage: 'ru' })
    expect(call('ai:save', next)).toEqual({ saved: next, active, restartRequired: true })
    expect(loadSettings(file)).toMatchObject({ language: 'ru', theme: 'dark', ai: next })
    expect(call<AiPreferences>('ai:get').active.backend).toBe('local')
    expect(check).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    hookAiPreferences({ file, active: next, restart, check, env: {} })
    expect(call<AiPreferences>('ai:get').restartRequired).toBe(false)
  })

  it('owns the active snapshot and does not expose it for callers to mutate', () => {
    active.backend = 'agy'
    const view = call<AiPreferences>('ai:get')
    expect(view.active.backend).toBe('local')
    view.active.backend = 'porch'
    expect(call<AiPreferences>('ai:get').active.backend).toBe('local')
  })

  it('rejects malformed saves and checks before reaching persistence or executables', async () => {
    const invalid: unknown[] = [null, {}, { ...active, backend: 'shell' }, { ...active, command: 'rm -rf /' },
      { ...active, agyPath: 'agy\n--flag' }, { ...active, timeoutSeconds: 0 }, { ...active, contextTokens: Number.NaN },
      { ...active, textEffort: 'extreme' }, { ...active, outputLanguage: 'fr' }]
    for (const value of invalid) {
      expect(() => call('ai:save', value)).toThrow('Invalid AI settings')
      await expect(call('ai:check', value)).rejects.toThrow('Invalid AI settings')
    }
    expect(existsSync(file)).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('checks unsaved settings without saving them or changing the active provider', async () => {
    const draft = aiSettings({ backend: 'agy', agyPath: '/Users/test folder/bin/agy' })
    expect(await call('ai:check', draft)).toEqual({ ok: true, message: 'Available executable' })
    expect(check).toHaveBeenCalledExactlyOnceWith(draft)
    expect(existsSync(file)).toBe(false)
    expect(call<AiPreferences>('ai:get').active.backend).toBe('local')
  })

  it('returns executable failures as a failed check without losing saved settings', async () => {
    const next = aiSettings({ backend: 'agy' })
    call('ai:save', next)
    const saved = readFileSync(file, 'utf8')
    check.mockRejectedValueOnce(new Error('Executable not found'))
    expect(await call('ai:check', next)).toEqual({ ok: false, message: 'Executable not found' })
    expect(readFileSync(file, 'utf8')).toBe(saved)
    expect(call<AiPreferences>('ai:get').restartRequired).toBe(true)
  })

  it('uses the harness availability checker when no checker is injected', async () => {
    hookAiPreferences({ file, active, restart, env: {} })
    const next = aiSettings({ backend: 'agy' })
    expect(await call('ai:check', next)).toEqual({ ok: true, message: 'agy 1.5.4' })
    expect(checkHarness).toHaveBeenCalledExactlyOnceWith(next)
  })

  it('leaves the active snapshot intact when saving fails', () => {
    const missing = join(dir, 'missing', 'settings.json')
    hookAiPreferences({ file: missing, active, restart, check, env: {} })
    expect(() => call('ai:save', aiSettings({ backend: 'agy' }))).toThrow()
    expect(call('ai:get')).toEqual({ saved: active, active, restartRequired: false })
    expect(existsSync(missing)).toBe(false)
  })

  it('returns the restart guard result and keeps pending changes on a blocked restart', () => {
    call('ai:save', aiSettings({ backend: 'agy' }))
    restart.mockReturnValueOnce(false)
    expect(call('ai:restart')).toBe(false)
    expect(call<AiPreferences>('ai:get').restartRequired).toBe(true)
    expect(call('ai:restart')).toBe(true)
    expect(restart).toHaveBeenCalledTimes(2)
  })

  it('reports environment-controlled mode changes without promising a restart will apply them', () => {
    const env = { YOGURT_AI_BACKEND: 'agy' }
    active = configuredAi({}, env)
    hookAiPreferences({ file, active, restart, check, env })
    const saved = aiSettings({ ...active, backend: 'porch' })
    // nothing was stored yet, so the locked field keeps the shown (effective) value
    expect(call('ai:save', saved)).toEqual({ saved: active, active, restartRequired: false, locked: { backend: { variable: 'YOGURT_AI_BACKEND', value: 'agy' } } })
    expect(loadSettings(file).ai?.backend).toBe('agy')
    expect(call<AiPreferences>('ai:get').active.backend).toBe('agy')
    expect(restart).not.toHaveBeenCalled()
  })

  it('keeps the stored backend when the launch mode is locked, while other fields still save', () => {
    updateSettings(file, { ai: aiSettings({ backend: 'porch' }) })
    const env = { YOGURT_AI_BACKEND: 'agy' }
    active = configuredAi({}, env)
    hookAiPreferences({ file, active, restart, check, env })
    // the form shows the effective agy mode; saving must not overwrite the stored Porch choice
    const form = aiSettings({ ...active, textModel: 'gemini-4-argon' })
    expect(call<AiPreferences>('ai:save', form).saved.backend).toBe('porch')
    expect(loadSettings(file).ai).toMatchObject({ backend: 'porch', textModel: 'gemini-4-argon' })
    expect(call<AiPreferences>('ai:get').locked).toEqual({ backend: { variable: 'YOGURT_AI_BACKEND', value: 'agy' } })
  })

  it('still requires one restart for independent model changes under an environment-controlled mode', () => {
    const env = { YOGURT_AI_BACKEND: 'agy' }
    active = configuredAi({}, env)
    hookAiPreferences({ file, active, restart, check, env })
    const saved = aiSettings({ ...active, backend: 'porch', textModel: 'gemini-4-argon' })
    expect(call<AiPreferences>('ai:save', saved).restartRequired).toBe(true)
    const written = aiSettings({ ...active, textModel: 'gemini-4-argon' })
    expect(loadSettings(file).ai).toEqual(written)
    const nextActive = configuredAi({ ai: written }, env)
    hookAiPreferences({ file, active: nextActive, restart, check, env })
    expect(call('ai:get')).toEqual({ saved: written, active: nextActive, restartRequired: false, locked: { backend: { variable: 'YOGURT_AI_BACKEND', value: 'agy' } } })
    expect(nextActive).toMatchObject({ backend: 'agy', textModel: 'gemini-4-argon' })
  })

  it('applies executable-path overrides when determining the next launch and retains the stored paths', () => {
    updateSettings(file, { ai: aiSettings({ agyPath: '/saved/agy', porchPath: '/saved/porch' }) })
    const env = { YOGURT_AGY_PATH: '/opt/provider/agy', YOGURT_PORCH_PATH: '/opt/provider/porch' }
    active = configuredAi({}, env)
    hookAiPreferences({ file, active, restart, check, env })
    const form = aiSettings({ ...active, textModel: 'gemini-4-argon' })
    expect(call('ai:save', form)).toEqual({
      saved: aiSettings({ agyPath: '/saved/agy', porchPath: '/saved/porch', textModel: 'gemini-4-argon' }), active, restartRequired: true,
      locked: { agyPath: { variable: 'YOGURT_AGY_PATH', value: '/opt/provider/agy' }, porchPath: { variable: 'YOGURT_PORCH_PATH', value: '/opt/provider/porch' } },
    })
    expect(loadSettings(file).ai).toMatchObject({ agyPath: '/saved/agy', porchPath: '/saved/porch', textModel: 'gemini-4-argon' })
  })
})
