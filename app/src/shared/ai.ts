/** Subscription CLIs keep their own authentication; Yogurt never stores API keys. */
export type AiBackend = 'agy' | 'porch' | 'local'
export type AiEffort = 'low' | 'medium' | 'high'
export type AiOutputLanguage = 'auto' | 'ru' | 'en'

export type AiSettings = {
  backend: AiBackend
  agyPath: string
  porchPath: string
  transcriptionModel: string
  transcriptionEffort: AiEffort
  textModel: string
  textEffort: AiEffort
  transcriptionProfile: string
  textProfile: string
  outputLanguage: AiOutputLanguage
  /** A finite deadline for each CLI request, including time spent waiting for the provider. */
  timeoutSeconds: number
  /** Conservative input budget; CLI backends do not expose a tokenizer. */
  contextTokens: number
}

export const DEFAULT_AI_SETTINGS: Readonly<AiSettings> = {
  backend: 'agy',
  agyPath: 'agy',
  porchPath: 'porch',
  transcriptionModel: 'gemini-3.8-flash',
  transcriptionEffort: 'medium',
  textModel: 'gemini-3.8-flash',
  textEffort: 'medium',
  transcriptionProfile: 'agy-gemini-3.8-flash',
  textProfile: 'agy-gemini-3.8-flash',
  outputLanguage: 'auto',
  timeoutSeconds: 600,
  contextTokens: 32_768,
}

export type AiEnvironmentOverride = 'YOGURT_AI_BACKEND' | 'YOGURT_AGY_PATH' | 'YOGURT_PORCH_PATH'
export type AiPreferences = {
  saved: AiSettings
  active: AiSettings
  restartRequired: boolean
  /** Launch variables take precedence over these saved fields, including after restart. */
  environmentOverrides?: AiEnvironmentOverride[]
}
export type AiCheck = { ok: boolean; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => values.includes(v as T) ? v as T : fallback
const text = (v: unknown, fallback: string, limit: number) => typeof v === 'string' && v.trim() && v.length <= limit && !/[\x00-\x1f]/.test(v) ? v.trim() : fallback
const profile = (v: unknown, fallback: string) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v) ? v : fallback
const number = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback

/** Normalize persisted settings. CLI arguments are always passed separately, never through a shell. */
export function aiSettings(value: unknown): AiSettings {
  const v = isRecord(value) ? value : {}
  const d = DEFAULT_AI_SETTINGS
  return {
    backend: oneOf(v.backend, ['agy', 'porch', 'local'], d.backend),
    agyPath: text(v.agyPath, d.agyPath, 4096),
    porchPath: text(v.porchPath, d.porchPath, 4096),
    transcriptionModel: text(v.transcriptionModel, d.transcriptionModel, 200),
    // low silently truncates long audio, so transcription never offers it; a saved low loads as medium.
    transcriptionEffort: oneOf(v.transcriptionEffort, ['medium', 'high'], d.transcriptionEffort),
    textModel: text(v.textModel, d.textModel, 200),
    textEffort: oneOf(v.textEffort, ['low', 'medium', 'high'], d.textEffort),
    transcriptionProfile: profile(v.transcriptionProfile, d.transcriptionProfile),
    textProfile: profile(v.textProfile, d.textProfile),
    outputLanguage: oneOf(v.outputLanguage, ['auto', 'ru', 'en'], d.outputLanguage),
    timeoutSeconds: number(v.timeoutSeconds, d.timeoutSeconds, 10, 1800),
    contextTokens: number(v.contextTokens, d.contextTokens, 8192, 1_048_576),
  }
}

/** low silently truncates long audio; clamp it even when a caller bypassed aiSettings. */
export function clampTranscriptionEffort(effort: AiEffort): AiEffort {
  return effort === 'low' ? 'medium' : effort
}

/** Reject malformed IPC input instead of saving a different configuration than the screen showed. */
export function validAiSettings(value: unknown): value is AiSettings {
  if (!isRecord(value)) return false
  const normalized = aiSettings(value)
  return Object.keys(normalized).every(key => value[key] === normalized[key as keyof AiSettings])
    && Object.keys(value).every(key => Object.hasOwn(normalized, key))
}
