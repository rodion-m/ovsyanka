import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SPOKEN, spokenOf, whisperLanguage } from '../src/shared/spoken'
import { loadSettings, spokenSetting, updateSettings } from '../src/main/settings'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en-US'] }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, BrowserWindow: {}, nativeTheme: {} }))
import { hookPreferences } from '../src/main/preferences'

const dirs: string[] = []
const settingsFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-spoken-'))
  dirs.push(dir)
  return join(dir, 'settings.json')
}
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); handlers.clear() })

describe('the spoken language setting', () => {
  it('defaults to Multi-language while keeping explicit English and Russian', () => {
    expect(SPOKEN).toEqual(['en', 'ru', 'multi'])
    expect(spokenOf(undefined)).toBe('multi')
    expect(spokenOf('en')).toBe('en')
    expect(spokenOf('ru')).toBe('ru')
    expect(spokenOf('multi')).toBe('multi')
    expect(spokenOf('klingon')).toBe('multi')
    expect(spokenSetting({})).toBe('multi')
    expect(spokenSetting({ spoken: 'ru' })).toBe('ru')
    expect(spokenSetting({ spoken: 'multi' })).toBe('multi')
  })
  it('persists every explicit choice, including Multi-language', () => {
    const file = settingsFile()
    updateSettings(file, { spoken: 'ru' })
    expect(spokenSetting(loadSettings(file))).toBe('ru')
    updateSettings(file, { spoken: 'multi' })
    expect(loadSettings(file).spoken).toBe('multi')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ spoken: 'multi' })
  })
  it('migrates an old profile without spoken once, leaves a new profile on multi, and keeps explicit values', () => {
    const old = settingsFile()
    writeFileSync(old, JSON.stringify({ language: 'ru' }))
    expect(loadSettings(old)).toMatchObject({ language: 'ru', spoken: 'en', spokenMigrated: 2 })
    expect(loadSettings(old).spoken).toBe('en')
    const fresh = settingsFile()
    expect(loadSettings(fresh)).toEqual({})
    expect(spokenSetting(loadSettings(fresh))).toBe('multi')
    updateSettings(fresh, { language: 'ru' })
    expect(loadSettings(fresh)).toMatchObject({ spoken: 'multi', spokenMigrated: 2 })
    updateSettings(fresh, { spoken: 'ru', spokenMigrated: 2 })
    expect(loadSettings(fresh).spoken).toBe('ru')
  })
  it('passes English and Russian directly to Whisper, and lets Multi-language detect', () => {
    expect(whisperLanguage('en')).toBe('en')
    expect(whisperLanguage('ru')).toBe('ru')
    expect(whisperLanguage('multi')).toBeUndefined()
  })
  it('keeps Russian through the renderer IPC and a reload, independent of the interface language', () => {
    const file = settingsFile()
    updateSettings(file, { language: 'en', myName: 'Родион' })
    const onSpoken = vi.fn()
    const deps = { file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin: vi.fn(), loginOn: () => false, macName: () => 'Родион', relaunch: () => false, setTrayVisible: vi.fn(), onSpoken }
    hookPreferences(deps)
    const get = () => handlers.get('settings:get')!()
    const set = (value: unknown) => handlers.get('settings:spoken')!(null, value)
    expect(get().spoken).toBe('multi')
    set('ru')
    expect(loadSettings(file)).toMatchObject({ spoken: 'ru', language: 'en', myName: 'Родион' })
    expect(onSpoken).toHaveBeenLastCalledWith('ru')
    hookPreferences(deps)
    expect(get()).toMatchObject({ spoken: 'ru', language: 'en', locale: 'en', myName: 'Родион' })

    for (const invalid of [undefined, null, '', 'russian', 'ru-RU', 'uk', true, 1]) set(invalid)
    expect(onSpoken).toHaveBeenCalledTimes(1)
    expect(get().spoken).toBe('ru')
    set('multi')
    expect(get().spoken).toBe('multi')
    expect(loadSettings(file).spoken).toBe('multi')
    set('en')
    expect(get().spoken).toBe('en')
    // English is no longer the default: the explicit choice is written down
    expect(loadSettings(file).spoken).toBe('en')
    expect(onSpoken.mock.calls.map(([value]) => value)).toEqual(['ru', 'multi', 'en'])
  })
})
