import { ipcMain } from 'electron'
import { aiSettings, validAiSettings, type AiCheck, type AiPreferences, type AiSettings } from '../../shared/ai'
import { configuredAi, loadSettings, updateSettings } from '../settings'
import { checkHarness } from './index'

/** Environment variables that fix a settings field for the whole launch. */
const envLocks = { YOGURT_AI_BACKEND: 'backend', YOGURT_AGY_PATH: 'agyPath', YOGURT_PORCH_PATH: 'porchPath' } as const

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
  const locked: NonNullable<AiPreferences['locked']> = {}
  for (const variable of Object.keys(envLocks) as (keyof typeof envLocks)[]) {
    const field = envLocks[variable]
    if (env[variable]) locked[field] = { variable, value: String(active[field]) }
  }
  const savedSettings = () => aiSettings(loadSettings(o.file).ai ?? active)
  const preferences = (): AiPreferences => {
    const saved = savedSettings()
    const nextLaunch = configuredAi({ ai: saved }, env)
    return {
      saved, active: { ...active }, restartRequired: JSON.stringify(nextLaunch) !== JSON.stringify(active),
      ...(Object.keys(locked).length ? { locked } : {}),
    }
  }
  const checked = (value: unknown): AiSettings => {
    if (!validAiSettings(value)) throw new Error('Invalid AI settings')
    return aiSettings(value)
  }

  ipcMain.handle('ai:get', preferences)
  ipcMain.handle('ai:save', (_e, value: unknown) => {
    const settings = checked(value)
    // a field fixed by a launch variable keeps its stored value: the form shows the effective one instead
    const previous = savedSettings()
    if (locked.backend) settings.backend = previous.backend
    if (locked.agyPath) settings.agyPath = previous.agyPath
    if (locked.porchPath) settings.porchPath = previous.porchPath
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
