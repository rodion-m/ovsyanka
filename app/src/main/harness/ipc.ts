import { ipcMain } from 'electron'
import { aiSettings, validAiSettings, type AiCheck, type AiKeyStatus, type AiPreferences, type AiProbeResult, type AiSettings, type AiUsage } from '../../shared/ai'
import { configuredAi, keyLast4, loadSettings, updateSettings } from '../settings'
import { checkHarness } from './index'
import { getAiOptions } from './aiOptions'
import type { OpenRouterKeyStore } from './openrouterKey'
import type { OpenRouterUsage } from './openrouterUsage'

/** Environment variables that fix a settings field for the whole launch. */
const envLocks = { YOGURT_AI_BACKEND: 'backend', YOGURT_AGY_PATH: 'agyPath', YOGURT_PORCH_PATH: 'porchPath', YOGURT_OPENROUTER_API_KEY: 'openrouterKey' } as const

/** A launch keeps one provider configuration. Saving changes only the next launch. */
export function hookAiPreferences(o: {
  file: string
  active: AiSettings
  restart: () => boolean
  /** Checks executable availability/version only; never starts a model request. */
  check?: (settings: AiSettings) => Promise<AiCheck>
  env?: NodeJS.ProcessEnv
  openrouterKey?: string
  openrouter?: Pick<OpenRouterKeyStore, 'status' | 'set' | 'clear' | 'check'>
  usage?: Pick<OpenRouterUsage, 'summary'>
  probe?: (settings: AiSettings, task: 'text' | 'transcription') => Promise<AiProbeResult>
  onAiConfigChanged?: () => void | Promise<void>
}) {
  const active = aiSettings(o.active)
  const env = { ...(o.env ?? process.env) }
  const locked: NonNullable<AiPreferences['locked']> = {}
  for (const variable of Object.keys(envLocks) as (keyof typeof envLocks)[]) {
    const field = envLocks[variable]
    const value = field === 'openrouterKey' ? (o.openrouterKey ?? env[variable]) : env[variable]
    if (value) locked[field] = { variable, value: field === 'openrouterKey' ? keyLast4(String(value)) : String(active[field]) }
  }
  const savedSettings = () => aiSettings(loadSettings(o.file).ai ?? active)
  const recoverSpool = () => {
    try {
      void Promise.resolve(o.onAiConfigChanged?.()).catch(error => console.error('AI spool recovery after settings changed failed', error))
    } catch (error) { console.error('AI spool recovery after settings changed failed', error) }
  }
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
    recoverSpool()
    return preferences()
  })
  ipcMain.handle('ai:check', async (_e, value: unknown): Promise<AiCheck> => {
    const settings = checked(value)
    try { return await (o.check ?? checkHarness)(settings) }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Could not check the AI executable' } }
  })
  ipcMain.handle('ai:options', async (_e, request: unknown) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid AI options request')
    const value = request as Record<string, unknown>
    if (value.backend !== 'agy' && value.backend !== 'porch' && value.backend !== 'openrouter') throw new Error('Unsupported AI options backend')
    if (value.refresh !== undefined && typeof value.refresh !== 'boolean') throw new Error('Invalid AI options refresh flag')
    for (const field of ['agyPath', 'porchPath'] as const) {
      if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > 4096)) throw new Error('Invalid AI executable path')
    }
    return getAiOptions({ backend: value.backend, refresh: value.refresh as boolean | undefined,
      agyPath: value.agyPath as string | undefined, porchPath: value.porchPath as string | undefined })
  })
  ipcMain.handle('ai:restart', () => o.restart())
  ipcMain.handle('ai.openrouter.keyStatus', async (): Promise<AiKeyStatus> => o.openrouter ? o.openrouter.status() : { state: 'none' })
  ipcMain.handle('ai.openrouter.setKey', async (_e, value: unknown): Promise<AiKeyStatus> => {
    if (!o.openrouter) return { state: 'unavailable' }
    const status = await o.openrouter.set(typeof value === 'string' ? value : '')
    if (status.state === 'ok' || status.state === 'unchecked') recoverSpool()
    return status
  })
  ipcMain.handle('ai.openrouter.clearKey', async (): Promise<AiKeyStatus> => o.openrouter ? o.openrouter.clear() : { state: 'none' })
  ipcMain.handle('ai.openrouter.checkKey', async (): Promise<AiKeyStatus> => o.openrouter ? o.openrouter.check() : { state: 'none' })
  ipcMain.handle('ai.openrouter.usage', async (): Promise<AiUsage> => o.usage ? o.usage.summary() : { todayUsd: 0, thirtyDayUsd: 0, transcriptionPerHourUsd: {}, transcriptionCostUnknown: false, textCostUnknown: false, missingCostCount: 0 })
  ipcMain.handle('ai.openrouter.probe', async (_e, value: unknown, task: unknown): Promise<AiProbeResult> => {
    const settings = checked(value)
    if (settings.backend !== 'openrouter' || (task !== 'text' && task !== 'transcription')) throw new Error('Invalid OpenRouter test request')
    if (!o.probe) return { ok: false, elapsedMs: 0, message: 'OpenRouter tests are unavailable.' }
    return o.probe(settings, task)
  })
}
