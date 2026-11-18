import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AiOptions,
  type AiProblemCode,
  type OpenRouterModel,
  normalizeOpenRouterResponse,
  selectTextOptions,
  selectTranscriptionOptions,
} from '../../shared/aiCatalog'

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const OPENROUTER_TRANSCRIPTION_MODELS_URL = `${OPENROUTER_MODELS_URL}?output_modalities=transcription`
export const OPENROUTER_MODELS_CACHE_SCHEMA = 1 as const
export const OPENROUTER_MODELS_CACHE_FILE = 'openrouter-models.json'
export const OPENROUTER_MODELS_FRESHNESS_MS = 24 * 60 * 60 * 1_000
export const OPENROUTER_MODELS_REFRESH_THROTTLE_MS = 2 * 60 * 1_000
export const OPENROUTER_MODELS_TIMEOUT_MS = 15 * 1_000

export type OpenRouterFetch = (input: string | URL, init?: RequestInit) => Promise<Response>
export type OpenRouterModelsClock = () => number

export type OpenRouterModelsCache = {
  schema: typeof OPENROUTER_MODELS_CACHE_SCHEMA
  fetchedAt: number
  text: OpenRouterModel[]
  stt: OpenRouterModel[]
  probes: Record<string, { timestamps: boolean; at: number }>
}

export type OpenRouterModelsDependencies = {
  userData: string
  fetch: OpenRouterFetch
  now?: OpenRouterModelsClock
  timeoutMs?: number
}

export type OpenRouterOptionsRequest = { refresh?: boolean }

type FetchProblem = { code: AiProblemCode }

class OpenRouterModelsProblem extends Error implements FetchProblem {
  constructor(readonly code: AiProblemCode) {
    super(code)
    this.name = 'OpenRouterModelsProblem'
  }
}

function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function validatedOpenRouterModelsCache(value: unknown, now = Date.now(), options: { allowStale?: boolean } = {}): OpenRouterModelsCache | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.schema !== OPENROUTER_MODELS_CACHE_SCHEMA || !finiteTime(raw.fetchedAt)) return undefined
  if (raw.fetchedAt > now || (!options.allowStale && now - raw.fetchedAt > OPENROUTER_MODELS_FRESHNESS_MS)) return undefined
  const text = Array.isArray(raw.text)
    ? raw.text.map(model => normalizeOpenRouterResponse({ data: [model] })[0]).filter((model): model is OpenRouterModel => !!model)
    : []
  const stt = Array.isArray(raw.stt)
    ? raw.stt.map(model => normalizeOpenRouterResponse({ data: [model] })[0]).filter((model): model is OpenRouterModel => !!model)
    : []
  // A cache with one half missing would silently remove an entire picker group. Treat it as
  // corrupt and leave the file in place for diagnosis/recovery by a later version.
  if (!text.length || !stt.length) return undefined
  const probes: OpenRouterModelsCache['probes'] = {}
  if (raw.probes && typeof raw.probes === 'object' && !Array.isArray(raw.probes)) {
    for (const [id, probe] of Object.entries(raw.probes)) {
      if (!probe || typeof probe !== 'object' || Array.isArray(probe)) continue
      const candidate = probe as Record<string, unknown>
      if (typeof candidate.timestamps === 'boolean' && finiteTime(candidate.at)) probes[id] = { timestamps: candidate.timestamps, at: candidate.at }
    }
  }
  return { schema: OPENROUTER_MODELS_CACHE_SCHEMA, fetchedAt: raw.fetchedAt, text, stt, probes }
}

function responseOk(response: Response): boolean {
  return typeof response.ok === 'boolean' ? response.ok : response.status >= 200 && response.status < 300
}

function classifyFetchFailure(error: unknown, timedOut: boolean): AiProblemCode {
  if (timedOut || (error instanceof Error && error.name === 'AbortError')) return 'timeout'
  if (error instanceof OpenRouterModelsProblem) return error.code
  return 'network'
}

function withProblem(options: AiOptions, problem: AiProblemCode | undefined): AiOptions {
  return problem ? { ...options, problem } : options
}

/** A stateful cache/fetcher. The state is intentionally scoped to one main-process instance. */
export class OpenRouterModels {
  private readonly now: OpenRouterModelsClock
  private readonly timeoutMs: number
  private lastNetworkRefreshAt: number | undefined
  private inFlight: Promise<AiOptions> | undefined
  private lastProblem: AiProblemCode | undefined

  constructor(private readonly dependencies: OpenRouterModelsDependencies) {
    this.now = dependencies.now ?? (() => Date.now())
    this.timeoutMs = dependencies.timeoutMs ?? OPENROUTER_MODELS_TIMEOUT_MS
  }

  private get cachePath(): string {
    return join(this.dependencies.userData, OPENROUTER_MODELS_CACHE_FILE)
  }

  private async readCache(): Promise<OpenRouterModelsCache | undefined> {
    try {
      const body = JSON.parse(await readFile(this.cachePath, 'utf8')) as unknown
      // Keep stale picker options available while refreshing, but adapter capability lookups
      // use the default strict freshness check before sending optional parameters.
      return validatedOpenRouterModelsCache(body, this.now(), { allowStale: true })
    } catch {
      return undefined
    }
  }

  private cacheOptions(cache: OpenRouterModelsCache): AiOptions {
    const now = this.now()
    return withProblem({
      transcription: selectTranscriptionOptions(cache.text, cache.stt, { now }),
      text: selectTextOptions(cache.text, { now }),
      source: 'cache',
      fetchedAt: cache.fetchedAt,
    }, this.lastProblem)
  }

  private builtin(problem: AiProblemCode): AiOptions {
    return { transcription: [], text: [], source: 'builtin', problem }
  }

  private canRefresh(now: number): boolean {
    return this.lastNetworkRefreshAt === undefined
      || now - this.lastNetworkRefreshAt >= OPENROUTER_MODELS_REFRESH_THROTTLE_MS
  }

  private async request(url: string, controller: AbortController): Promise<Response> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<Response>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new OpenRouterModelsProblem('timeout'))
      }, this.timeoutMs)
    })
    try {
      const response = await Promise.race([
        this.dependencies.fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        }),
        timeout,
      ])
      if (!responseOk(response)) throw new OpenRouterModelsProblem(response.status >= 500 ? 'unavailable' : 'network')
      return response
    } catch (error) {
      throw new OpenRouterModelsProblem(classifyFetchFailure(error, false))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async liveCache(previous: OpenRouterModelsCache | undefined): Promise<AiOptions> {
    const controllers = [new AbortController(), new AbortController()]
    try {
      const [textResponse, sttResponse] = await Promise.all([
        this.request(OPENROUTER_MODELS_URL, controllers[0]),
        this.request(OPENROUTER_TRANSCRIPTION_MODELS_URL, controllers[1]),
      ])
      const [textBody, sttBody] = await Promise.all([textResponse.json() as Promise<unknown>, sttResponse.json() as Promise<unknown>])
      const text = normalizeOpenRouterResponse(textBody)
      const stt = normalizeOpenRouterResponse(sttBody)
      if (!text.length || !stt.length) throw new OpenRouterModelsProblem('bad-response')
      const fetchedAt = this.now()
      const cache: OpenRouterModelsCache = {
        schema: OPENROUTER_MODELS_CACHE_SCHEMA,
        fetchedAt,
        text,
        stt,
        probes: previous?.probes ?? {},
      }
      await this.writeCache(cache)
      this.lastProblem = undefined
      return {
        transcription: selectTranscriptionOptions(text, stt, { now: fetchedAt }),
        text: selectTextOptions(text, { now: fetchedAt }),
        source: 'live',
        fetchedAt,
      }
    } catch (error) {
      controllers.forEach(controller => controller.abort())
      const problem = error instanceof OpenRouterModelsProblem ? error.code : 'unavailable'
      this.lastProblem = problem
      return previous ? withProblem(this.cacheOptions(previous), problem) : this.builtin(problem)
    }
  }

  private async writeCache(cache: OpenRouterModelsCache): Promise<void> {
    await mkdir(this.dependencies.userData, { recursive: true })
    const temporary = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.cachePath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private refresh(previous: OpenRouterModelsCache | undefined): Promise<AiOptions> {
    if (this.inFlight) return this.inFlight
    const startedAt = this.now()
    if (!this.canRefresh(startedAt)) return Promise.resolve(previous ? this.cacheOptions(previous) : this.builtin(this.lastProblem ?? 'network'))
    this.lastNetworkRefreshAt = startedAt
    const request = this.liveCache(previous)
    this.inFlight = request.finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /** Return cached options immediately; stale caches trigger one background refresh. */
  async openRouterOptions(request: OpenRouterOptionsRequest = {}): Promise<AiOptions> {
    const cache = await this.readCache()
    const now = this.now()
    if (request.refresh) return this.refresh(cache)
    if (!cache) return this.refresh(undefined)
    if (now - cache.fetchedAt < OPENROUTER_MODELS_FRESHNESS_MS) return this.cacheOptions(cache)
    void this.refresh(cache)
    return this.cacheOptions(cache)
  }
}

export function createOpenRouterModels(dependencies: OpenRouterModelsDependencies): OpenRouterModels {
  return new OpenRouterModels(dependencies)
}

let defaultCatalog: { userData: string; models: OpenRouterModels } | undefined

async function defaultOpenRouterModels(): Promise<OpenRouterModels> {
  const electron = await import('electron')
  const userData = electron.app.getPath('userData')
  if (!defaultCatalog || defaultCatalog.userData !== userData) {
    defaultCatalog = {
      userData,
      models: createOpenRouterModels({
        userData,
        fetch: electron.net.fetch.bind(electron.net) as unknown as OpenRouterFetch,
      }),
    }
  }
  return defaultCatalog.models
}

/**
 * Main-process entry point. The Electron import is lazy so pure tests can use the factory above
 * without booting Electron. IPC wiring in a later stage can call this function directly.
 */
export async function openRouterOptions(request: OpenRouterOptionsRequest = {}): Promise<AiOptions> {
  const catalog = await defaultOpenRouterModels()
  return catalog.openRouterOptions(request)
}
