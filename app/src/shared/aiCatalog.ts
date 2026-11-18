import type { AiEffort, AiProblemCode, OpenRouterAudioKind } from './ai'
export type { AiProblemCode, OpenRouterAudioKind } from './ai'

// ---- OpenRouter catalog types and pure functions ----

/** Labels used by the model picker. Keep the OpenRouter vocabulary separate from agy entries. */
export type AiHint = 'audio' | 'verified' | 'fast' | 'cheap' | 'free' | 'tokens' | 'expiring' | 'unavailable'

export type AiOption = {
  id: string
  label: string
  vendor?: string
  group: 'recommended' | 'audio' | 'stt' | 'text' | 'free' | 'alias' | 'unavailable'
  hints: AiHint[]
  detail?: string
  kind?: OpenRouterAudioKind
  efforts?: AiEffort[]
  addedAt?: number
  expiresOn?: string
  contextLength?: number
  price?: {
    perHourUsd?: number
    estimated?: boolean
    inPerMillionUsd?: number
    outPerMillionUsd?: number
  }
  disabledReason?: string
}

export type AiOptions = {
  transcription: AiOption[]
  text: AiOption[]
  source: 'live' | 'cache' | 'builtin'
  fetchedAt?: number
  problem?: AiProblemCode
}

/**
 * The deliberately small representation persisted by openrouterModels.ts. Field names retain
 * OpenRouter's spelling so a cache can be inspected or migrated without losing meaning.
 */
export type OpenRouterModel = {
  id: string
  name: string
  created?: number
  architecture: {
    input_modalities: string[]
    output_modalities: string[]
  }
  endpoints?: string[]
  pricing: {
    prompt?: string
    completion?: string
    audio?: string
  }
  context_length?: number
  supported_parameters?: string[]
  reasoning?: {
    supported_efforts?: string[]
  }
  top_provider?: {
    max_completion_tokens?: number | null
  }
  expiration_date?: string | null
  alias_target?: string | null
}

export const OPENROUTER_RECOMMENDED_MODEL_IDS = ['google/gemini-3.8-flash'] as const
export const OPENROUTER_CHAT_ENDPOINT = '/api/v1/chat/completions'
export const OPENROUTER_STT_ENDPOINT = '/api/v1/audio/transcriptions'
export const OPENROUTER_TEXT_CONTEXT_MINIMUM = 32_000
/** Audio chat requests reserve 48,000 completion tokens so long transcriptions are not silently capped. */
export const OPENROUTER_AUDIO_COMPLETION_MINIMUM = 48_000
/** Stage 0 measured Gemini 3.8 Flash chat-audio input at 25 tokens per second. */
export const OPENROUTER_AUDIO_TOKENS_PER_SECOND = 25
/** Completion includes reasoning tokens. Measured fixture rate: 11,986 tokens / 5 audio minutes. */
export const OPENROUTER_AUDIO_OUTPUT_TOKENS_PER_MINUTE = 2_397
export const OPENROUTER_HOURLY_PRICE_MIN_USD = 0.005
export const OPENROUTER_HOURLY_PRICE_MAX_USD = 3
export const OPENROUTER_EXPIRING_SOON_DAYS = 30

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  return result ? result : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return [...new Set(value.map(nonEmptyString).filter((item): item is string => !!item))]
}

function numericString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const result = value.trim()
    return result ? result : undefined
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nestedRecord(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined
}

/**
 * Normalize one raw API record into the fields that are safe and useful to cache. Unknown and
 * bulky fields (descriptions, links, benchmarks, pricing overrides, and so on) are discarded.
 * A record without its identity, name, or architecture cannot be classified and is skipped.
 */
export function normalizeOpenRouterModel(value: unknown): OpenRouterModel | undefined {
  const raw = nestedRecord(value)
  if (!raw) return undefined
  const id = nonEmptyString(raw.id)
  const name = nonEmptyString(raw.name)
  const architecture = nestedRecord(raw.architecture)
  if (!id || !name || !architecture) return undefined

  const inputModalities = stringArray(architecture.input_modalities) ?? []
  const outputModalities = stringArray(architecture.output_modalities) ?? []
  const pricing = nestedRecord(raw.pricing)
  const topProvider = nestedRecord(raw.top_provider)
  const reasoning = nestedRecord(raw.reasoning)
  const expiration = raw.expiration_date === null ? null : nonEmptyString(raw.expiration_date)
  const endpoints = stringArray(raw.endpoints)
  const supportedParameters = stringArray(raw.supported_parameters)
  const efforts = stringArray(reasoning?.supported_efforts)
  const created = finiteNumber(raw.created)
  const contextLength = finiteNumber(raw.context_length)
  const maxCompletionTokens = topProvider?.max_completion_tokens === null
    ? null
    : finiteNumber(topProvider?.max_completion_tokens)

  return {
    id,
    name,
    ...(created === undefined ? {} : { created }),
    architecture: { input_modalities: inputModalities, output_modalities: outputModalities },
    ...(endpoints === undefined ? {} : { endpoints }),
    pricing: {
      ...(numericString(pricing?.prompt) === undefined ? {} : { prompt: numericString(pricing?.prompt) }),
      ...(numericString(pricing?.completion) === undefined ? {} : { completion: numericString(pricing?.completion) }),
      ...(numericString(pricing?.audio) === undefined ? {} : { audio: numericString(pricing?.audio) }),
    },
    ...(contextLength === undefined ? {} : { context_length: contextLength }),
    ...(supportedParameters === undefined ? {} : { supported_parameters: supportedParameters }),
    ...(efforts === undefined ? {} : { reasoning: { supported_efforts: efforts } }),
    ...(topProvider === undefined ? {} : {
      top_provider: { max_completion_tokens: maxCompletionTokens },
    }),
    ...(raw.expiration_date === undefined ? {} : { expiration_date: expiration }),
    ...(raw.alias_target === undefined ? {} : { alias_target: nonEmptyString(raw.alias_target) ?? null }),
  }
}

/** Normalize an OpenRouter response body. The caller decides whether an empty result is an error. */
export function normalizeOpenRouterResponse(value: unknown): OpenRouterModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  return value.data.map(normalizeOpenRouterModel).filter((model): model is OpenRouterModel => !!model)
}

/** Alias used by callers that already know they are handling model records rather than a body. */
export const normalizeOpenRouterRecord = normalizeOpenRouterModel

function priceNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}

function isRouter(model: OpenRouterModel): boolean {
  return model.id.startsWith('openrouter/') || priceNumber(model.pricing.prompt) === -1
}

function isFree(model: OpenRouterModel): boolean {
  return priceNumber(model.pricing.prompt) === 0
}

function isCurrent(model: OpenRouterModel, now: number): boolean {
  const expiration = model.expiration_date
  if (!expiration) return true
  const at = Date.parse(expiration)
  return Number.isFinite(at) && at > now
}

function endpoint(model: OpenRouterModel, expected: string): boolean {
  // Older or partially populated responses omit endpoints. The plan treats those records as
  // chat models when their modalities say they produce text; STT requires an explicit endpoint.
  return model.endpoints === undefined
    ? expected === OPENROUTER_CHAT_ENDPOINT
    : model.endpoints.includes(expected)
}

function commonEligible(model: OpenRouterModel, now: number): boolean {
  return !model.id.endsWith(':batch') && !model.id.startsWith('~') && !isRouter(model) && isCurrent(model, now)
}

function isAudioChatModel(model: OpenRouterModel, now: number): boolean {
  const completionLimit = model.top_provider?.max_completion_tokens
  return commonEligible(model, now)
    && model.architecture.input_modalities.includes('audio')
    && model.architecture.output_modalities.includes('text')
    && endpoint(model, OPENROUTER_CHAT_ENDPOINT)
    && (completionLimit == null || completionLimit >= OPENROUTER_AUDIO_COMPLETION_MINIMUM)
}

function isSttModel(model: OpenRouterModel, now: number): boolean {
  return commonEligible(model, now)
    && model.architecture.output_modalities.includes('transcription')
    && endpoint(model, OPENROUTER_STT_ENDPOINT)
}

function isTextModel(model: OpenRouterModel, now: number): boolean {
  return commonEligible(model, now)
    && model.architecture.input_modalities.includes('text')
    && model.architecture.output_modalities.length === 1
    && model.architecture.output_modalities[0] === 'text'
    && (model.context_length ?? 0) >= OPENROUTER_TEXT_CONTEXT_MINIMUM
    && endpoint(model, OPENROUTER_CHAT_ENDPOINT)
}

function parseName(name: string): { label: string; vendor?: string } {
  const separator = name.indexOf(':')
  if (separator <= 0) return { label: name }
  const vendor = name.slice(0, separator).trim()
  const label = name.slice(separator + 1).trim()
  return label ? { label, ...(vendor ? { vendor } : {}) } : { label: name }
}

function modelEfforts(model: OpenRouterModel): AiEffort[] | undefined {
  const supported = model.reasoning?.supported_efforts
  if (!supported) return undefined
  const known: AiEffort[] = ['low', 'medium', 'high']
  const result = known.filter(effort => supported.includes(effort))
  return result.length ? result : undefined
}

function soonExpiration(value: Pick<OpenRouterModel, 'expiration_date'> | Pick<AiOption, 'expiresOn'> | string | null | undefined, now: number): boolean {
  let expiration: string | null | undefined
  if (typeof value === 'string' || value === null || value === undefined) expiration = value
  else if ('expiration_date' in value) expiration = value.expiration_date
  else expiration = (value as Pick<AiOption, 'expiresOn'>).expiresOn
  if (!expiration) return false
  const at = Date.parse(expiration)
  if (!Number.isFinite(at) || at <= now) return false
  return at <= now + OPENROUTER_EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000
}

/** True when the model's expiration date is in the next 30 days, but not already expired. */
export function isExpiringSoon(value: Pick<OpenRouterModel, 'expiration_date'> | Pick<AiOption, 'expiresOn'> | string | null | undefined, now = Date.now()): boolean {
  return soonExpiration(value, now)
}

/** Return the estimated hourly audio/STT cost only when the result is useful to show. */
export function estimateOpenRouterPricePerHour(model: OpenRouterModel, kind: OpenRouterAudioKind): number | undefined {
  const prompt = priceNumber(model.pricing.prompt)
  const completion = priceNumber(model.pricing.completion)
  if (prompt === undefined || completion === undefined || prompt < 0 || completion < 0) return undefined

  let hourly: number | undefined
  if (kind === 'chat') {
    const audio = priceNumber(model.pricing.audio ?? model.pricing.prompt)
    if (audio === undefined) return undefined
    hourly = audio * OPENROUTER_AUDIO_TOKENS_PER_SECOND * 3_600
      + completion * OPENROUTER_AUDIO_OUTPUT_TOKENS_PER_MINUTE * 60
  } else if (completion === 0) {
    hourly = prompt * 3_600
  }

  return hourly !== undefined
    && hourly >= OPENROUTER_HOURLY_PRICE_MIN_USD
    && hourly <= OPENROUTER_HOURLY_PRICE_MAX_USD
    ? hourly
    : undefined
}

/** Short alias for UI and tests that do not need the provider-specific name. */
export const estimatePricePerHour = estimateOpenRouterPricePerHour

function optionPrice(model: OpenRouterModel, kind?: OpenRouterAudioKind): AiOption['price'] {
  const input = priceNumber(kind === 'chat' ? model.pricing.audio ?? model.pricing.prompt : model.pricing.prompt)
  const output = priceNumber(model.pricing.completion)
  const perHourUsd = kind ? estimateOpenRouterPricePerHour(model, kind) : undefined
  const price = {
    ...(input !== undefined && input >= 0 ? { inPerMillionUsd: input * 1_000_000 } : {}),
    ...(output !== undefined && output >= 0 ? { outPerMillionUsd: output * 1_000_000 } : {}),
    ...(perHourUsd === undefined ? {} : { perHourUsd, estimated: true }),
  }
  return Object.keys(price).length ? price : undefined
}

function toOption(model: OpenRouterModel, group: AiOption['group'], kind: OpenRouterAudioKind | undefined, now: number): AiOption {
  const { label, vendor } = parseName(model.name)
  const hints: AiHint[] = []
  if (kind === 'chat') hints.push('audio')
  if (kind === 'stt' && priceNumber(model.pricing.completion) !== undefined && priceNumber(model.pricing.completion)! > 0) hints.push('tokens')
  if (isFree(model)) hints.push('free')
  if (soonExpiration(model, now)) hints.push('expiring')
  if (group === 'recommended') hints.push('verified')
  const efforts = modelEfforts(model)
  const price = optionPrice(model, kind)
  return {
    id: model.id,
    label,
    ...(vendor ? { vendor } : {}),
    group,
    hints,
    ...(kind ? { kind } : {}),
    ...(efforts ? { efforts } : {}),
    ...(model.created === undefined ? {} : { addedAt: model.created }),
    ...(model.expiration_date ? { expiresOn: model.expiration_date } : {}),
    ...(model.context_length === undefined ? {} : { contextLength: model.context_length }),
    ...(price ? { price } : {}),
  }
}

function normalizedModels(models: readonly OpenRouterModel[]): OpenRouterModel[] {
  return models.map(normalizeOpenRouterModel).filter((model): model is OpenRouterModel => !!model)
}

function recommended(models: readonly OpenRouterModel[], kind: OpenRouterAudioKind | undefined, group: AiOption['group'], now: number): AiOption[] {
  return OPENROUTER_RECOMMENDED_MODEL_IDS.flatMap(id => {
    const model = models.find(candidate => candidate.id === id)
    return model ? [toOption(model, group, kind, now)] : []
  })
}

export type AiSortMode = 'newest' | 'cheapest'

const groupOrder: Record<AiOption['group'], number> = {
  recommended: 0, audio: 1, stt: 2, text: 1, free: 3, alias: 4, unavailable: 5,
}

function compareNumbers(a: number | undefined, b: number | undefined, descending: boolean): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return descending ? b - a : a - b
}

function cheapValue(option: AiOption): number | undefined {
  if (option.kind) return option.price?.perHourUsd
  return option.price?.inPerMillionUsd
}

/** Sort without mutating the input. Missing dates/prices always follow known values. */
export function sortAiOptions(options: readonly AiOption[], mode: AiSortMode = 'newest'): AiOption[] {
  return [...options].sort((a, b) => {
    const groupDifference = groupOrder[a.group] - groupOrder[b.group]
    if (groupDifference) return groupDifference
    const primary = mode === 'newest'
      ? compareNumbers(a.addedAt, b.addedAt, true)
      : compareNumbers(cheapValue(a), cheapValue(b), false)
    return primary || a.id.localeCompare(b.id)
  })
}

/** Sort normalized records for callers that build their own option groups. */
export function sortOpenRouterModels(models: readonly OpenRouterModel[], mode: AiSortMode = 'newest', kind?: OpenRouterAudioKind): OpenRouterModel[] {
  const options = models.map(model => toOption(model, kind ? 'audio' : 'text', kind, Date.now()))
  const order = sortAiOptions(options, mode).map(option => option.id)
  return order.flatMap(id => {
    const model = models.find(candidate => candidate.id === id)
    return model ? [model] : []
  })
}

export type CatalogSelectionOptions = { now?: number; sort?: AiSortMode }

/** Select the transcription groups: recommended, paid chat-audio, paid STT, then all free. */
export function selectTranscriptionOptions(
  textModels: readonly OpenRouterModel[],
  sttModels: readonly OpenRouterModel[] = [],
  selection: CatalogSelectionOptions = {},
): AiOption[] {
  const now = selection.now ?? Date.now()
  const sort = selection.sort ?? 'newest'
  const text = normalizedModels(textModels).filter(model => isAudioChatModel(model, now))
  const stt = normalizedModels(sttModels).filter(model => isSttModel(model, now))
  const recommendedIds = new Set<string>(OPENROUTER_RECOMMENDED_MODEL_IDS)
  const recommendedOptions = recommended(text, 'chat', 'recommended', now)
  const paidAudio = text.filter(model => !recommendedIds.has(model.id) && !isFree(model)).map(model => toOption(model, 'audio', 'chat', now))
  const paidStt = stt.filter(model => !isFree(model)).map(model => toOption(model, 'stt', 'stt', now))
  const free = [
    ...text.filter(model => !recommendedIds.has(model.id) && isFree(model)).map(model => toOption(model, 'free', 'chat', now)),
    ...stt.filter(model => isFree(model)).map(model => toOption(model, 'free', 'stt', now)),
  ]
  return [
    ...sortAiOptions(recommendedOptions, sort),
    ...sortAiOptions(paidAudio, sort),
    ...sortAiOptions(paidStt, sort),
    ...sortAiOptions(free, sort),
  ]
}

/** Select the text groups: recommended, paid text, then free text. */
export function selectTextOptions(models: readonly OpenRouterModel[], selection: CatalogSelectionOptions = {}): AiOption[] {
  const now = selection.now ?? Date.now()
  const sort = selection.sort ?? 'newest'
  const normalized = normalizedModels(models).filter(model => isTextModel(model, now))
  const recommendedIds = new Set<string>(OPENROUTER_RECOMMENDED_MODEL_IDS)
  const recommendedOptions = recommended(normalized, undefined, 'recommended', now)
  const paid = normalized.filter(model => !recommendedIds.has(model.id) && !isFree(model)).map(model => toOption(model, 'text', undefined, now))
  const free = normalized.filter(model => !recommendedIds.has(model.id) && isFree(model)).map(model => toOption(model, 'free', undefined, now))
  return [
    ...sortAiOptions(recommendedOptions, sort),
    ...sortAiOptions(paid, sort),
    ...sortAiOptions(free, sort),
  ]
}

export const selectForTranscription = selectTranscriptionOptions
export const selectForText = selectTextOptions

/** True when a selected ID is absent from the fresh options returned by OpenRouter. */
export function isModelMissing(modelId: string, options: readonly Pick<AiOption, 'id'>[]): boolean {
  return !options.some(option => option.id === modelId)
}

export function missingModelIds(modelIds: readonly string[], options: readonly Pick<AiOption, 'id'>[]): string[] {
  return modelIds.filter(modelId => isModelMissing(modelId, options))
}

export const modelIsMissing = isModelMissing

// ---- agy built-in catalog and picker helpers ----

/**
 * The agy list built into the app, mirroring `agy models` 1.5.11 (plan 3.3). A later stage can
 * extend it with live `agy models` output; hints come only from this built-in list. Gemini 4
 * Hydrogen also offers xhigh upstream, but AiSettings cannot store that level yet.
 */
export const AGY_BUILTIN_MODELS: readonly AiOption[] = [
  {
    id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', vendor: 'Google',
    group: 'recommended', hints: ['audio', 'verified'], efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', vendor: 'Google',
    group: 'audio', hints: ['audio'], efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-4-argon', label: 'Gemini 4 Argon', vendor: 'Google',
    group: 'audio', hints: ['audio'], efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-opus-5-5', label: 'Claude Opus 5.5', vendor: 'Anthropic',
    group: 'text', hints: [], efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', vendor: 'Anthropic',
    group: 'text', hints: [], efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-oss-120b', label: 'GPT-OSS 120B', vendor: 'OpenAI',
    group: 'text', hints: [], efforts: ['medium'],
  },
]

/** Transcription needs native audio input, so only audio-flagged models are listed; the rest stay reachable through a custom ID. */
export function agyTranscriptionOptions(): AiOption[] {
  return AGY_BUILTIN_MODELS.filter(option => option.hints.includes('audio'))
}

/** Every built-in model can produce text; non-recommended entries sit in the text group here. */
export function agyTextOptions(): AiOption[] {
  return AGY_BUILTIN_MODELS.map(option => option.group === 'recommended' ? option : { ...option, group: 'text' as const })
}

/** Search the picker's options: every whitespace-separated word must appear in the name, ID or vendor, case-insensitive. */
export function searchAiOptions(options: readonly AiOption[], query: string): AiOption[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...options]
  return options.filter(option => {
    const text = `${option.label} ${option.id} ${option.vendor ?? ''}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
}

export const CUSTOM_ID_MAX_LENGTH = 200
const CUSTOM_ID_PATTERN = /^[A-Za-z0-9._\-/:]+$/

/** Custom IDs accept Latin letters, digits and the signs . - _ / : (plan 2.3), up to 200 characters. */
export function validCustomId(id: string): boolean {
  return id.length > 0 && id.length <= CUSTOM_ID_MAX_LENGTH && CUSTOM_ID_PATTERN.test(id)
}
