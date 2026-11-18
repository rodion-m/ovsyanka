import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenRouterModels,
  OPENROUTER_MODELS_CACHE_FILE,
  OPENROUTER_MODELS_FRESHNESS_MS,
  OPENROUTER_MODELS_TIMEOUT_MS,
  OPENROUTER_MODELS_URL,
  OPENROUTER_TRANSCRIPTION_MODELS_URL,
  type OpenRouterFetch,
  type OpenRouterModelsCache,
} from '../src/main/harness/openrouterModels'
import { normalizeOpenRouterResponse } from '../src/shared/aiCatalog'

type JsonBody = { data: unknown[] }
const textBody = JSON.parse(await readFile(new URL('./fixtures/openrouter/models-2026-11-18.json', import.meta.url), 'utf8')) as JsonBody
const sttBody = JSON.parse(await readFile(new URL('./fixtures/openrouter/models-transcription-2026-11-18.json', import.meta.url), 'utf8')) as JsonBody
const textModels = normalizeOpenRouterResponse(textBody)
const sttModels = normalizeOpenRouterResponse(sttBody)
const nowOnSnapshotDate = Date.parse('2026-11-18T12:00:00Z')

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.useRealTimers()
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'yogurt-openrouter-models-'))
  roots.push(value)
  return value
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fetchFixtures(): ReturnType<typeof vi.fn<OpenRouterFetch>> {
  return vi.fn(async (input: string | URL) => input.toString() === OPENROUTER_MODELS_URL ? response(textBody) : response(sttBody))
}

function seedCache(fetchedAt: number): OpenRouterModelsCache {
  return { schema: 1, fetchedAt, text: [textModels[0]!], stt: [sttModels[0]!], probes: {} }
}

async function writeSeed(userData: string, fetchedAt: number, body = seedCache(fetchedAt)): Promise<string> {
  const path = join(userData, OPENROUTER_MODELS_CACHE_FILE)
  await writeFile(path, JSON.stringify(body), 'utf8')
  return path
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('OpenRouter model cache and network boundary', () => {
  it('uses a fresh real cache file without making either network request', async () => {
    const userData = await root()
    const fetchedAt = nowOnSnapshotDate
    await writeSeed(userData, fetchedAt)
    const fetch = vi.fn<OpenRouterFetch>(() => Promise.reject(new Error('network must not run')))
    const catalog = createOpenRouterModels({ userData, fetch, now: () => fetchedAt + OPENROUTER_MODELS_FRESHNESS_MS - 1 })

    const result = await catalog.openRouterOptions()
    expect(result.source).toBe('cache')
    expect(result.fetchedAt).toBe(fetchedAt)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns stale cache immediately and atomically replaces it after a background refresh', async () => {
    const userData = await root()
    const fetchedAt = nowOnSnapshotDate - OPENROUTER_MODELS_FRESHNESS_MS - 1
    const path = await writeSeed(userData, fetchedAt)
    const fetch = fetchFixtures()
    const catalog = createOpenRouterModels({ userData, fetch, now: () => nowOnSnapshotDate })

    const result = await catalog.openRouterOptions()
    expect(result.source).toBe('cache')
    expect(fetch).toHaveBeenCalledTimes(2)
    await catalog.openRouterOptions({ refresh: true })
    await nextTurn()
    const updated = JSON.parse(await readFile(path, 'utf8')) as OpenRouterModelsCache
    expect(updated.schema).toBe(1)
    expect(updated.fetchedAt).toBe(nowOnSnapshotDate)
    expect(updated.text.length).toBe(478)
    expect(updated.stt.length).toBe(30)
  })

  it('keeps stale cache bytes unchanged for a server error and a malformed body', async () => {
    const userData = await root()
    const path = await writeSeed(userData, nowOnSnapshotDate - OPENROUTER_MODELS_FRESHNESS_MS - 1)
    const before = await readFile(path)
    const serverFetch = vi.fn<OpenRouterFetch>(async () => response({ error: 'server' }, 500))
    const serverCatalog = createOpenRouterModels({ userData, fetch: serverFetch, now: () => nowOnSnapshotDate })
    await serverCatalog.openRouterOptions()
    await serverCatalog.openRouterOptions({ refresh: true })
    expect(await readFile(path)).toEqual(before)

    const invalidFetch = vi.fn<OpenRouterFetch>(async () => response({ data: [] }))
    const invalidCatalog = createOpenRouterModels({ userData, fetch: invalidFetch, now: () => nowOnSnapshotDate + 3 * 60_000 })
    await invalidCatalog.openRouterOptions({ refresh: true })
    expect(await readFile(path)).toEqual(before)
  })

  it('keeps stale cache bytes unchanged when the 15-second request deadline expires', async () => {
    expect(OPENROUTER_MODELS_TIMEOUT_MS).toBe(15_000)
    const userData = await root()
    const path = await writeSeed(userData, nowOnSnapshotDate - OPENROUTER_MODELS_FRESHNESS_MS - 1)
    const before = await readFile(path)
    vi.useFakeTimers()
    const fetch = vi.fn<OpenRouterFetch>(() => new Promise(() => undefined))
    const catalog = createOpenRouterModels({ userData, fetch, now: () => nowOnSnapshotDate, timeoutMs: 15_000 })
    const stale = await catalog.openRouterOptions()
    expect(stale.source).toBe('cache')
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15_000)
    const after = await catalog.openRouterOptions({ refresh: true })
    expect(after.source).toBe('cache')
    expect(after.problem).toBe('timeout')
    expect(await readFile(path)).toEqual(before)
  })

  it('ignores corrupt cache and returns an explicit builtin failure when live data is unavailable', async () => {
    const userData = await root()
    const path = join(userData, OPENROUTER_MODELS_CACHE_FILE)
    await writeFile(path, '{ definitely not json', 'utf8')
    const before = await readFile(path)
    const fetch = vi.fn<OpenRouterFetch>(async () => response({ error: 'down' }, 500))
    const catalog = createOpenRouterModels({ userData, fetch, now: () => nowOnSnapshotDate })

    const result = await catalog.openRouterOptions()
    expect(result).toEqual({ transcription: [], text: [], source: 'builtin', problem: 'unavailable' })
    expect(await readFile(path)).toEqual(before)
  })

  it('throttles failed refreshes for two minutes, then permits the next one', async () => {
    const userData = await root()
    await writeSeed(userData, nowOnSnapshotDate - OPENROUTER_MODELS_FRESHNESS_MS - 1)
    let now = nowOnSnapshotDate
    const fetch = vi.fn<OpenRouterFetch>(async () => response({ error: 'down' }, 500))
    const catalog = createOpenRouterModels({ userData, fetch, now: () => now })

    await catalog.openRouterOptions()
    await catalog.openRouterOptions({ refresh: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    now += 119_999
    await catalog.openRouterOptions({ refresh: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    now += 1
    await catalog.openRouterOptions({ refresh: true })
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
