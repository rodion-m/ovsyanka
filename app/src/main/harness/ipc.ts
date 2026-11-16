import { ipcMain } from 'electron'
import { aiSettings, validAiSettings, type AiCheck, type AiPreferences, type AiSettings } from '../../shared/ai'
import { configuredAi, loadSettings, updateSettings } from '../settings'
import { checkHarness } from './index'

/** A launch keeps one provider configuration. Saving changes only the next launch. */
export function hookAiPreferences(o: {
  file: string
  active: AiSettings
  restart: () => boolean
  /** Checks executable availability/version only; never starts a model request. */
  check?: (settings: AiSettings) => Promise<AiCheck>
  env?: NodeJS.ProcessEnv
}) {
  const active = aiSettings(o.active)
  const env = { ...(o.env ?? process.env) }
  const overrides = (['YOGURT_AI_BACKEND', 'YOGURT_AGY_PATH', 'YOGURT_PORCH_PATH'] as const).filter(key => !!env[key])
  const preferences = (): AiPreferences => {
    const saved = aiSettings(loadSettings(o.file).ai ?? active)
    const nextLaunch = configuredAi({ ai: saved }, env)
    return {
      saved, active: { ...active }, restartRequired: JSON.stringify(nextLaunch) !== JSON.stringify(active),
      ...(overrides.length ? { environmentOverrides: [...overrides] } : {}),
    }
  }
  const checked = (value: unknown): AiSettings => {
    if (!validAiSettings(value)) throw new Error('Invalid AI settings')
    return aiSettings(value)
  }

  ipcMain.handle('ai:get', preferences)
  ipcMain.handle('ai:save', (_e, value: unknown) => {
    const settings = checked(value)
    updateSettings(o.file, { ai: settings })
    return preferences()
  })
  ipcMain.handle('ai:check', async (_e, value: unknown): Promise<AiCheck> => {
    const settings = checked(value)
    try { return await (o.check ?? checkHarness)(settings) }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Could not check the AI executable' } }
  })
  ipcMain.handle('ai:restart', () => o.restart())
}
