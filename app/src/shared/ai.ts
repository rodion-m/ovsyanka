/** Subscription CLIs keep their own authentication; the OpenRouter key is stored outside settings. */
export type AiBackend = 'agy' | 'porch' | 'openrouter' | 'local'
export type AiEffort = 'low' | 'medium' | 'high'
export type AiOutputLanguage = 'auto' | 'ru' | 'en'
export type OpenRouterAudioKind = 'chat' | 'stt'
export type OpenRouterDataPolicy = 'deny' | 'zdr' | 'any'
export type AiProblemCode = 'auth' | 'credits' | 'budget' | 'rate-limit' | 'model-gone' | 'no-provider'
  | 'unavailable' | 'timeout' | 'network' | 'too-large' | 'moderation' | 'truncated'
  | 'no-timestamps' | 'bad-response' | 'no-key' | 'keychain' | 'local-audio'
  | 'cli-missing' | 'cli-failed' | 'cli-config'
/** Main-to-renderer notice about the last remote transcription failure; a null code clears it. */
export type AiCli = 'agy' | 'Porch'
export type AiProblemEvent = { code: AiProblemCode | null; meetingId: string; track: 'me' | 'them'; model?: string; cli?: AiCli; at: number }
export type AiProblemUpdate = { code: AiProblemCode; meetingId: string; track: 'me' | 'them'; model?: string; cli?: AiCli } | { code: null; meetingId: string; track: 'me' | 'them' }

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
  openrouterTranscriptionModel: string
  openrouterTranscriptionKind: OpenRouterAudioKind
  openrouterTextModel: string
  openrouterDataPolicy: OpenRouterDataPolicy
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
  openrouterTranscriptionModel: 'google/gemini-3.8-flash',
  openrouterTranscriptionKind: 'chat',
  openrouterTextModel: 'google/gemini-3.8-flash',
  openrouterDataPolicy: 'deny',
  outputLanguage: 'auto',
  timeoutSeconds: 600,
  contextTokens: 32_768,
}

/** Settings fields a launch environment variable can fix for the whole run; openrouterKey arrives with the OpenRouter mode. */
export type AiLockedField = 'backend' | 'agyPath' | 'porchPath' | 'openrouterKey'
export type AiPreferences = {
  saved: AiSettings
  active: AiSettings
  restartRequired: boolean
  /** Launch variables take precedence over these saved fields, including after restart. The form shows the effective value; saving keeps the stored choice. */
  locked?: Partial<Record<AiLockedField, { variable: string; value: string }>>
}
export type AiCheck = { ok: boolean; message: string }
export type AiKeyStatus =
  | { state: 'none' | 'unreadable' | 'unavailable' }
  | { state: 'ok' | 'rejected' | 'unchecked'; source: 'keychain' | 'env'; last4: string
      label?: string; remainingUsd?: number | null; checkedAt?: number; problem?: AiProblemCode }
export type AiUsage = {
  todayUsd: number
  thirtyDayUsd: number
  transcriptionPerHourUsd: Record<string, number>
  transcriptionCostUnknown: boolean
  textCostUnknown: boolean
  missingCostCount: number
}
export type AiProbeResult = { ok: boolean; elapsedMs: number; message?: string; costUsd?: number }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => values.includes(v as T) ? v as T : fallback
const text = (v: unknown, fallback: string, limit: number) => typeof v === 'string' && v.trim() && v.length <= limit && !/[\x00-\x1f]/.test(v) ? v.trim() : fallback
const profile = (v: unknown, fallback: string) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v) ? v : fallback
const openrouterModel = (v: unknown, fallback: string) => typeof v === 'string' && v.length <= 200 && /^~?[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v) ? v : fallback
const number = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback

/** Normalize persisted settings. CLI arguments are always passed separately, never through a shell. */
export function aiSettings(value: unknown): AiSettings {
  const v = isRecord(value) ? value : {}
  const d = DEFAULT_AI_SETTINGS
  return {
    backend: oneOf(v.backend, ['agy', 'porch', 'openrouter', 'local'], d.backend),
    agyPath: text(v.agyPath, d.agyPath, 4096),
    porchPath: text(v.porchPath, d.porchPath, 4096),
    transcriptionModel: text(v.transcriptionModel, d.transcriptionModel, 200),
    // low silently truncates long audio, so transcription never offers it; a saved low loads as medium.
    transcriptionEffort: oneOf(v.transcriptionEffort, ['medium', 'high'], d.transcriptionEffort),
    textModel: text(v.textModel, d.textModel, 200),
    textEffort: oneOf(v.textEffort, ['low', 'medium', 'high'], d.textEffort),
    transcriptionProfile: profile(v.transcriptionProfile, d.transcriptionProfile),
    textProfile: profile(v.textProfile, d.textProfile),
    openrouterTranscriptionModel: openrouterModel(v.openrouterTranscriptionModel, d.openrouterTranscriptionModel),
    openrouterTranscriptionKind: oneOf(v.openrouterTranscriptionKind, ['chat', 'stt'], d.openrouterTranscriptionKind),
    openrouterTextModel: openrouterModel(v.openrouterTextModel, d.openrouterTextModel),
    openrouterDataPolicy: oneOf(v.openrouterDataPolicy, ['deny', 'zdr', 'any'], d.openrouterDataPolicy),
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
