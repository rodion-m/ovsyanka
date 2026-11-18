import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiProblemCode, AiSettings, OpenRouterDataPolicy } from '../../shared/ai'
import { clampTranscriptionEffort } from '../../shared/ai'
import type { OpenRouterModel } from '../../shared/aiCatalog'
import { STRICT_TRANSCRIPT_SCHEMA, TRANSCRIPTION_RULES, type AudioRequest } from './transcribe'
import { aborted, assertRunning, HarnessError } from './process'
import type { OpenRouterKeyFetch, OpenRouterKeyStore } from './openrouterKey'
import type { OpenRouterUsage } from './openrouterUsage'
import { validatedOpenRouterModelsCache } from './openrouterModels'

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'
export const OPENROUTER_CHAT_URL = `${OPENROUTER_API_BASE}/chat/completions`
export const OPENROUTER_AUDIO_URL = OPENROUTER_CHAT_URL
export const OPENROUTER_MAX_ATTEMPTS = 3
const RESPONSE_LIMIT = 1024 * 1024
const RECOMMENDED_CAPABILITIES: OpenRouterModel = {
  id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', created: 0,
  context_length: 1_000_000, architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text'] },
  pricing: { prompt: '0.000000825', completion: '0.000004125', audio: '0.000000825' }, top_provider: { max_completion_tokens: 65_536 },
  supported_parameters: ['structured_outputs', 'reasoning', 'temperature'], reasoning: { supported_efforts: ['low', 'medium', 'high'] },
}

export type OpenRouterModelLookup = (model: string) => Promise<OpenRouterModel | undefined>
export type OpenRouterSleep = (ms: number, signal?: AbortSignal) => Promise<void>
export type OpenRouterLogEntry = {
  model: string
  status: number
  error_type?: string
  generationId?: string
  durationMs: number
  bodySize: number
  costUsd?: number
}

export type OpenRouterDependencies = {
  settings: AiSettings
  key: Pick<OpenRouterKeyStore, 'read'> & Partial<Pick<OpenRouterKeyStore, 'markRejected'>>
  fetch: OpenRouterKeyFetch
  userData?: string
  lookupModel?: OpenRouterModelLookup
  usage?: Pick<OpenRouterUsage, 'record'>
  now?: () => number
  sleep?: OpenRouterSleep
  log?: (entry: OpenRouterLogEntry) => void
  baseUrl?: string
}

type ErrorShape = { code: AiProblemCode; errorType?: string; permanent: boolean; retryAfterMs?: number }
type Body = Record<string, unknown>

function record(value: unknown): Body | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Body : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function safeDiagnostic(value: unknown, key?: string): string | undefined {
  const text = stringValue(value)
  if (!text || text.length > 120 || !/^[A-Za-z0-9_./:-]+$/.test(text)) return undefined
  if (key && key.length >= 8) for (let i = 0; i <= key.length - 8; i++) if (text.includes(key.slice(i, i + 8))) return undefined
  return text
}

function safeModel(value: string): string {
  return value.replace(/[^A-Za-z0-9_./:~ -]/g, '_').slice(0, 200)
}

function nestedError(body: Body | undefined): Body | undefined {
  return record(body?.error)
}

function signalFields(body: Body | undefined): string {
  const error = nestedError(body)
  const metadata = record(error?.metadata) ?? record(body?.metadata)
  const fields = [
    error?.type, error?.error_type, error?.code, error?.message,
    body?.error_type, body?.type, body?.code,
    metadata?.limit_source, metadata?.error_type, metadata?.provider_name,
  ].filter(value => typeof value === 'string').join(' ').toLowerCase()
  return fields.slice(0, 4096)
}

function errorTypeOf(body: Body | undefined): string | undefined {
  const error = nestedError(body)
  return safeDiagnostic(error?.error_type ?? error?.type ?? body?.error_type ?? body?.type)
}

function parseRetryAfter(response: Response, now: number): number | undefined {
  const value = response.headers.get('Retry-After')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.round(seconds * 1_000))
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return undefined
  return Math.min(60_000, Math.max(0, at - now))
}

/** Classify an OpenRouter response without copying any provider message into an error. */
export function classifyOpenRouterError(status: number, body: unknown): ErrorShape {
  const object = record(body)
  const error = nestedError(object)
  const type = `${stringValue(error?.error_type) ?? ''} ${stringValue(error?.type) ?? ''} ${stringValue(object?.error_type) ?? ''}`.toLowerCase()
  const signal = signalFields(object)
  const errorType = errorTypeOf(object)
  let code: AiProblemCode
  if (status === 401 || type.includes('auth') || type.includes('unauthorized')) code = 'auth'
  else if (status === 413 || type.includes('too_large') || type.includes('payload') || (signal.includes('payload') && (signal.includes('too large') || signal.includes('too_large')))) code = 'too-large'
  else if (status === 429 || type.includes('rate_limit') || type.includes('rate-limit')) code = 'rate-limit'
  else if (status === 408 || status === 504 || status === 524 || type.includes('timeout')) code = 'timeout'
  else if (type.includes('moderation') || type.includes('content_filter') || signal.includes('content_filter') || signal.includes('refusal') || (record(error?.metadata)?.reasons !== undefined)) code = 'moderation'
  else if (signal.includes('openrouter_in_flight_budget') || signal.includes('in_flight_budget')) code = 'rate-limit'
  else if (signal.includes('openrouter_credits') || signal.includes('credits')) code = 'credits'
  else if (signal.includes('openrouter_key_limit') || signal.includes('key_limit') || signal.includes('budget')) code = 'budget'
  else if (status === 400 && signal.includes('not a valid model id')) code = 'model-gone'
  else if (status === 404 || type.includes('not_found') || type.includes('model_not_found')) code = signal.includes('provider') ? 'no-provider' : 'model-gone'
  else if (signal.includes('no provider') || signal.includes('no_provider')) code = 'no-provider'
  else if (status === 403) code = 'auth'
  else if (status === 502 || status === 503 || type.includes('provider_overloaded') || type.includes('provider_unavailable')) code = 'unavailable'
  else if (status >= 500) code = 'unavailable'
  else if (status === 402) code = 'credits'
  else code = 'bad-response'
  const permanent = ['truncated', 'bad-response', 'no-timestamps', 'too-large', 'moderation'].includes(code)
  const optionalParameterError = status === 400 && /unsupported|not supported|unknown parameter|invalid (?:parameter|schema)|response_format|structured.outputs|reasoning|temperature/i.test(signal)
  return { code, permanent: permanent && !optionalParameterError, ...(errorType ? { errorType } : {}) }
}

function retryable(code: AiProblemCode): boolean {
  return code === 'rate-limit' || code === 'unavailable' || code === 'timeout' || code === 'network'
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(aborted())
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

function responseOk(response: Response): boolean {
  return typeof response.ok === 'boolean' ? response.ok : response.status >= 200 && response.status < 300
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function usageOf(body: Body | undefined): { costUsd?: number; promptTokens?: number; completionTokens?: number } {
  const usage = record(body?.usage)
  if (!usage) return {}
  const cost = numeric(usage.cost)
  const promptTokens = numeric(usage.prompt_tokens)
  const completionTokens = numeric(usage.completion_tokens)
  return {
    ...(cost !== undefined && cost >= 0 ? { costUsd: cost } : {}),
    ...(promptTokens !== undefined && promptTokens >= 0 ? { promptTokens } : {}),
    ...(completionTokens !== undefined && completionTokens >= 0 ? { completionTokens } : {}),
  }
}

function providerFor(policy: OpenRouterDataPolicy, requireParameters: boolean): Record<string, unknown> | undefined {
  const provider: Record<string, unknown> = {}
  if (requireParameters) provider.require_parameters = true
  if (policy === 'deny') provider.data_collection = 'deny'
  else if (policy === 'zdr') provider.zdr = true
  return Object.keys(provider).length ? provider : undefined
}

function supportsEffort(model: OpenRouterModel | undefined, effort: string): boolean {
  return !!model?.reasoning?.supported_efforts?.includes(effort)
}

function supportsStructured(model: OpenRouterModel | undefined): boolean {
  return !!model?.supported_parameters?.includes('structured_outputs')
}

function maxTokensFor(requested: number, model: OpenRouterModel | undefined): number {
  const wanted = Math.max(1, Math.min(8_192, Number.isSafeInteger(requested) ? requested : 2_048)) + 16_384
  const cap = model?.top_provider?.max_completion_tokens
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.min(wanted, cap) : wanted
}

function maxAudioTokensFor(model: OpenRouterModel | undefined): number {
  const cap = model?.top_provider?.max_completion_tokens
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.min(48_000, cap) : 48_000
}

function paidModel(model: OpenRouterModel | undefined, modelId: string): boolean {
  if (!model) return !modelId.endsWith(':free')
  const prices = [model?.pricing.audio, model?.pricing.prompt, model?.pricing.completion]
  return prices.some(value => value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0)
}

function audioSeconds(bytes: Buffer): number {
  return bytes.length > 44 ? Math.max(0, (bytes.length - 44) / 32_000) : 0
}

function contentOf(body: Body | undefined): { content?: string; finishReason?: string; nativeFinishReason?: string } {
  const choice = Array.isArray(body?.choices) ? record(body.choices[0]) : undefined
  const message = record(choice?.message)
  return {
    ...(typeof message?.content === 'string' ? { content: message.content } : {}),
    ...(typeof choice?.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
    ...(typeof choice?.native_finish_reason === 'string' ? { nativeFinishReason: choice.native_finish_reason } : {}),
  }
}

async function cachedModel(userData: string | undefined, model: string, now: number): Promise<OpenRouterModel | undefined> {
  if (!userData) return undefined
  try {
    const cache = validatedOpenRouterModelsCache(JSON.parse(await readFile(join(userData, 'openrouter-models.json'), 'utf8')), now)
    for (const candidate of [...(cache?.text ?? []), ...(cache?.stt ?? [])]) if (candidate.id === model) return candidate
  } catch { /* an unavailable cache only omits optional request parameters */ }
  return undefined
}

export class OpenRouterAdapter {
  private readonly now: () => number
  private readonly sleep: OpenRouterSleep
  private readonly log: (entry: OpenRouterLogEntry) => void
  private readonly baseUrl: string

  constructor(private readonly dependencies: OpenRouterDependencies) {
    this.now = dependencies.now ?? (() => Date.now())
    this.sleep = dependencies.sleep ?? defaultSleep
    this.log = dependencies.log ?? (entry => console.info('openrouter request', entry))
    this.baseUrl = dependencies.baseUrl ?? OPENROUTER_API_BASE
  }

  private async model(model: string): Promise<OpenRouterModel | undefined> {
    const found = await this.dependencies.lookupModel?.(model)
    const cache = found?.id === model ? found : await cachedModel(this.dependencies.userData, model, this.now())
    if (model === RECOMMENDED_CAPABILITIES.id && cache) {
      const seed = RECOMMENDED_CAPABILITIES
      return {
        ...seed, ...cache,
        architecture: {
          input_modalities: cache.architecture.input_modalities.length ? cache.architecture.input_modalities : seed.architecture.input_modalities,
          output_modalities: cache.architecture.output_modalities.length ? cache.architecture.output_modalities : seed.architecture.output_modalities,
        },
        endpoints: cache.endpoints?.length ? cache.endpoints : seed.endpoints,
        pricing: { ...seed.pricing, ...cache.pricing },
        context_length: cache.context_length ?? seed.context_length,
        top_provider: {
          ...seed.top_provider, ...cache.top_provider,
          ...(cache.top_provider?.max_completion_tokens == null ? { max_completion_tokens: seed.top_provider?.max_completion_tokens } : {}),
        },
        supported_parameters: [...new Set([...(seed.supported_parameters ?? []), ...(cache.supported_parameters ?? [])])],
        reasoning: { ...seed.reasoning, ...cache.reasoning, supported_efforts: [...new Set([...(seed.reasoning?.supported_efforts ?? []), ...(cache.reasoning?.supported_efforts ?? [])])] },
      }
    }
    return cache ?? (model === RECOMMENDED_CAPABILITIES.id ? RECOMMENDED_CAPABILITIES : undefined)
  }

  private async fetchWithTimeout<T>(url: string, init: RequestInit, signal: AbortSignal, audio: boolean, consume: (response: Response) => Promise<T>): Promise<T> {
    const timeoutMs = Math.max(this.dependencies.settings.timeoutSeconds, audio ? 600 : 0) * 1_000
    const controller = new AbortController()
    let timedOut = false
    const relay = () => controller.abort()
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    signal.addEventListener('abort', relay, { once: true })
    try {
      if (signal.aborted) throw aborted()
      const response = await this.dependencies.fetch(url, { ...init, signal: controller.signal })
      if (timedOut) throw new HarnessError('OpenRouter request timed out.', 'timeout')
      return await consume(response)
    } catch (error) {
      if (signal.aborted) throw aborted()
      if (timedOut) throw new HarnessError('OpenRouter request timed out.', 'timeout')
      if (error instanceof HarnessError) throw error
      throw new HarnessError('Could not reach OpenRouter.', 'network')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', relay)
    }
  }

  private async request(model: string, body: Record<string, unknown>, signal: AbortSignal, audio: boolean, task: 'text' | 'transcription', seconds: number, costUnknown = false): Promise<string> {
    let lastError: HarnessError | undefined
    let requestBody = body
    let optionalFallbackUsed = false
    for (let attempt = 0; attempt < OPENROUTER_MAX_ATTEMPTS; attempt++) {
      assertRunning(signal)
      const started = this.now()
      let status = 0, bodySize = 0, generationId: string | undefined, errorType: string | undefined, costUsd: number | undefined, response: Response | undefined
      const logAttempt = () => this.log({ model: safeModel(model), status, ...(errorType ? { error_type: errorType } : {}), ...(generationId ? { generationId } : {}), durationMs: Math.max(0, this.now() - started), bodySize, ...(costUsd === undefined ? {} : { costUsd }) })
      try {
        const key = await this.dependencies.key.read()
        const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
        const result = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
          method: 'POST', headers, body: JSON.stringify(requestBody),
        }, signal, audio, async received => {
          response = received
          status = received.status
          const length = Number(received.headers.get('Content-Length'))
          if (Number.isFinite(length) && length > RESPONSE_LIMIT) { try { await received.body?.cancel() } catch { /* preserve size classification */ }; throw new HarnessError('OpenRouter returned an oversized response.', 'too-large', 0, undefined, true) }
          const reader = received.body?.getReader()
          if (!reader) return await received.text()
          const chunks: Uint8Array[] = []; let size = 0
          while (true) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.byteLength
            if (size > RESPONSE_LIMIT) { await reader.cancel().catch(() => undefined); throw new HarnessError('OpenRouter returned an oversized response.', 'too-large', 0, undefined, true) }
            chunks.push(part.value)
          }
          return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
        })
        const text = result
        if (!response) throw new HarnessError('OpenRouter did not return a response.', 'bad-response')
        status = response.status
        bodySize = Buffer.byteLength(text, 'utf8')
        let parsed: unknown
        try { parsed = text ? JSON.parse(text) : undefined } catch { if (responseOk(response)) throw new HarnessError('OpenRouter returned an invalid response.', 'bad-response') }
        const object = record(parsed)
        generationId = safeDiagnostic(object?.id, key) ?? safeDiagnostic(response.headers.get('X-Generation-Id'), key)
        const usage = usageOf(object)
        costUsd = usage.costUsd
        errorType = safeDiagnostic(errorTypeOf(object), key)
        if (responseOk(response) && !object?.error) await this.dependencies.usage?.record({ model, task, costUsd: usage.costUsd ?? 0, audioSeconds: seconds, costUnknown: costUnknown && usage.costUsd === 0 && seconds > 0, costMissing: usage.costUsd === undefined }).catch(() => undefined)
        const errorBody = object?.error != null && object.error !== ''
        if (!responseOk(response) || errorBody) {
          const classified = classifyOpenRouterError(status, object)
          const code = classified.code
          if (code === 'auth') this.dependencies.key.markRejected?.(key, 'auth')
          lastError = new HarnessError(`OpenRouter request failed (${code}).`, code, attempt + 1, safeModel(model), classified.permanent)
          const unsupported = status === 400 && /unsupported|not supported|unknown parameter|invalid (?:parameter|schema)|response_format|structured.outputs|reasoning|temperature/i.test(signalFields(object))
          if (unsupported && !optionalFallbackUsed) {
            optionalFallbackUsed = true
            requestBody = { ...requestBody }
            delete requestBody.response_format
            delete requestBody.reasoning
            delete requestBody.temperature
            if (record(requestBody.provider)?.require_parameters === true) requestBody.provider = { ...record(requestBody.provider), require_parameters: false }
            continue
          }
          const retryAfterMs = parseRetryAfter(response, this.now())
          const classifiedType = classified.errorType
          errorType = safeDiagnostic(classifiedType, key) ?? errorType
          if (!retryable(code) || attempt + 1 >= OPENROUTER_MAX_ATTEMPTS) throw lastError
          logAttempt()
          await this.sleep(retryAfterMs ?? (attempt === 0 ? 2_000 : 8_000), signal)
          continue
        }
        const content = contentOf(object)
        const message = record(object?.choices instanceof Array ? record(object.choices[0])?.message : undefined)
        if (content.finishReason === 'content_filter' || content.nativeFinishReason === 'content_filter' || message?.refusal != null) throw new HarnessError('OpenRouter moderated this request.', 'moderation', attempt + 1, safeModel(model), true)
        const returnedModel = safeDiagnostic(object?.model, key)
        if (returnedModel && returnedModel !== model) console.info('openrouter response model differs from request', { requested: safeModel(model), returned: safeModel(returnedModel) })
        if (content.finishReason === 'length' || content.nativeFinishReason === 'MAX_TOKENS') {
          throw new HarnessError('OpenRouter truncated the response.', 'truncated', attempt + 1, safeModel(model), true)
        }
        if (!content.content?.trim()) {
          const code: AiProblemCode = content.finishReason === 'length' ? 'truncated' : 'bad-response'
          throw new HarnessError(code === 'truncated' ? 'OpenRouter truncated the response.' : 'OpenRouter returned no answer.', code, attempt + 1, safeModel(model), true)
        }
        logAttempt()
        return content.content
      } catch (error) {
        if (signal.aborted) throw aborted()
        const harnessError = error instanceof HarnessError
          ? new HarnessError(error.message, error.code, error.attempts || attempt + 1, error.model ?? safeModel(model), error.permanent)
          : undefined
        if (harnessError?.code && retryable(harnessError.code) && attempt + 1 < OPENROUTER_MAX_ATTEMPTS) {
          lastError = harnessError
          logAttempt()
          await this.sleep(attempt === 0 ? 2_000 : 8_000, signal)
          continue
        }
        if (harnessError) {
          logAttempt()
          throw harnessError
        }
        lastError = new HarnessError('OpenRouter request failed.', 'network', attempt + 1)
        logAttempt()
        if (attempt + 1 < OPENROUTER_MAX_ATTEMPTS) {
          await this.sleep(attempt === 0 ? 2_000 : 8_000, signal)
          continue
        }
        throw lastError
      }
    }
    throw lastError ?? new HarnessError('OpenRouter request failed.', 'network')
  }

  async text(prompt: string, signal: AbortSignal, maxOutputTokens = 2_048): Promise<string> {
    assertRunning(signal)
    const modelId = this.dependencies.settings.openrouterTextModel
    const model = await this.model(modelId)
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokensFor(maxOutputTokens, model),
      ...(supportsEffort(model, this.dependencies.settings.textEffort) ? { reasoning: { effort: this.dependencies.settings.textEffort } } : {}),
      ...(providerFor(this.dependencies.settings.openrouterDataPolicy, false) ? { provider: providerFor(this.dependencies.settings.openrouterDataPolicy, false) } : {}),
      stream: false,
    }
    return this.request(modelId, body, signal, false, 'text', 0)
  }

  async transcribe(request: AudioRequest): Promise<string> {
    assertRunning(request.signal)
    if (this.dependencies.settings.openrouterTranscriptionKind !== 'chat') throw new HarnessError('OpenRouter STT transcription is not available yet.', 'unavailable')
    const modelId = this.dependencies.settings.openrouterTranscriptionModel
    const model = await this.model(modelId)
    let audio: Buffer
    try { audio = await readFile(join(request.directory, 'audio.wav')) }
    catch { throw new HarnessError('The staged recording could not be read.', 'local-audio', 0, undefined, true) }
    const language = request.language ? `Expected spoken language: ${request.language}.` : ''
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: 'user', content: [
        { type: 'text', text: ['Return only one JSON object matching {"language":"...","error":"...","segments":[{"start":0,"end":0,"text":"..."}]}.', TRANSCRIPTION_RULES, language, request.instructions].filter(Boolean).join('\n') },
        { type: 'input_audio', input_audio: { data: audio.toString('base64'), format: 'wav' } },
      ] }],
      ...(supportsStructured(model) ? { response_format: { type: 'json_schema', json_schema: { name: 'transcript', strict: true, schema: STRICT_TRANSCRIPT_SCHEMA } } } : {}),
      ...(supportsEffort(model, clampTranscriptionEffort(this.dependencies.settings.transcriptionEffort)) ? { reasoning: { effort: clampTranscriptionEffort(this.dependencies.settings.transcriptionEffort) } } : {}),
      ...(providerFor(this.dependencies.settings.openrouterDataPolicy, true) ? { provider: providerFor(this.dependencies.settings.openrouterDataPolicy, true) } : {}),
      max_tokens: Math.min(request.maxOutputTokens ?? 48_000, maxAudioTokensFor(model)),
      ...(model?.supported_parameters?.includes('temperature') || (!model && modelId === RECOMMENDED_CAPABILITIES.id) ? { temperature: 0 } : {}),
      stream: false,
    }
    return this.request(modelId, body, request.signal, true, 'transcription', audioSeconds(audio), paidModel(model, modelId))
  }
}

export function createOpenRouter(dependencies: OpenRouterDependencies): OpenRouterAdapter {
  return new OpenRouterAdapter(dependencies)
}
