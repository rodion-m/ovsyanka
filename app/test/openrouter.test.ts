import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { aiSettings, type AiProblemUpdate, type AiSettings } from '../src/shared/ai'
import { classifyOpenRouterError, createOpenRouter, type OpenRouterLogEntry } from '../src/main/harness/openrouter'
import { HarnessError } from '../src/main/harness/process'
import { createOpenRouterUsage, openRouterLocalDateKey } from '../src/main/harness/openrouterUsage'
import type { OpenRouterKeyFetch } from '../src/main/harness/openrouterKey'
import { checkHarness, createSubscriptionHarness } from '../src/main/harness'
import { createHarnessTranscriber, parseTranscript } from '../src/main/harness/transcribe'
import { createSpool, spoolDirOf } from '../src/main/asr/spool'
import { createPipeline } from '../src/main/asr/pipeline'
import { wavBytes } from '../src/main/asr/transcribe'
import type { Chunk } from '../src/main/asr/chunker'

const KEY = `sk-or-v1-${'abcdef0123456789'.repeat(4)}`
const LIVE_FIXTURES = join(process.cwd(), 'test/fixtures/openrouter/live')
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })) ) })

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'yogurt-openrouter-'))
  roots.push(path)
  return path
}

async function liveFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(LIVE_FIXTURES, name), 'utf8')) as unknown
}

function answer(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function model(over: Record<string, unknown> = {}) {
  return {
    id: 'google/gemini-3.8-flash', name: 'Google: Gemini',
    architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002', audio: '0.000003' },
    supported_parameters: ['structured_outputs', 'reasoning'],
    reasoning: { supported_efforts: ['low', 'medium', 'high'] },
    top_provider: { max_completion_tokens: 20_000 },
    ...over,
  } as never
}

function settings(over: Partial<AiSettings> = {}): AiSettings {
  return aiSettings({ backend: 'openrouter', ...over })
}

function key() { return { read: async () => KEY } }
function signal() { return new AbortController().signal }

describe('OpenRouter text adapter', () => {
  it('starts without a key, reports the OpenRouter loaded model, and fails requests explicitly with no-key', async () => {
    expect(await checkHarness(settings())).toMatchObject({ ok: true })
    const rootPath = await root()
    const harness = createSubscriptionHarness({ settings: settings(), tempDir: join(rootPath, 'stage') })
    const llm = await harness.model.llm()
    expect(harness.model.loaded()).toBe('openrouter:google/gemini-3.8-flash')
    await expect(llm.chat('without a key', () => {})).rejects.toMatchObject({ code: 'no-key' })
    harness.stop()
  })

  it('builds one un-attributed text request with policy, supported effort and bounded output', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch: OpenRouterKeyFetch = async (url, init) => { calls.push({ url: String(url), init }); return answer({ id: 'gen-1', choices: [{ message: { content: 'OK' } }], usage: { cost: 0.0004 } }) }
    const adapter = createOpenRouter({ settings: settings({ textEffort: 'medium' }), key: key(), fetch, lookupModel: async () => model() })
    await expect(adapter.text('Limit the answer to at most 2048 tokens.', signal())).resolves.toBe('OK')
    expect(calls).toHaveLength(1)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' })
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'google/gemini-3.8-flash', max_tokens: 18_432, reasoning: { effort: 'medium' }, provider: { data_collection: 'deny' }, stream: false })
    expect(body.messages).toEqual([{ role: 'user', content: 'Limit the answer to at most 2048 tokens.' }])
  })

  it('logs a provider model mismatch without failing an otherwise valid response', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => answer({ model: 'other/provider-model', choices: [{ message: { content: 'valid' } }] }), lookupModel: async () => model() })
    await expect(adapter.text('model mismatch', signal())).resolves.toBe('valid')
    expect(info).toHaveBeenCalledWith('openrouter response model differs from request', { requested: 'google/gemini-3.8-flash', returned: 'other/provider-model' })
  })

  it('omits optional parameters when the cached model does not advertise them and omits provider for any policy', async () => {
    let body!: Record<string, unknown>
    const fetch: OpenRouterKeyFetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return answer({ choices: [{ message: { content: 'done' } }] }) }
    const adapter = createOpenRouter({ settings: settings({ openrouterTextModel: 'acme/no-optional-parameters', openrouterDataPolicy: 'any', textEffort: 'high' }), key: key(), fetch, lookupModel: async () => model({ id: 'acme/no-optional-parameters', supported_parameters: [], reasoning: undefined }) })
    await expect(adapter.text('plain', signal())).resolves.toBe('done')
    expect(body.provider).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })

  it('uses static recommended capabilities on the production harness path', async () => {
    const rootPath = await root(), bodies: Record<string, unknown>[] = []
    const harness = createSubscriptionHarness({ settings: settings(), tempDir: join(rootPath, 'stage'), openrouter: {
      key: key(), fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return answer({ choices: [{ message: { content: JSON.stringify({ segments: [] }) } }] }) },
    } })
    const transcriber = harness.transcriber({ prompt: () => '', language: () => undefined, onLanguage: vi.fn() })
    await transcriber({ track: 'me', startMs: 0, samples: new Float32Array(16_000), clearMs: 500 })
    expect(bodies[0]).toMatchObject({ response_format: { json_schema: { strict: true } }, reasoning: { effort: 'medium' }, max_tokens: 48_000, temperature: 0 })
    const schema = (bodies[0].response_format as { json_schema: { schema: Record<string, unknown> } }).json_schema.schema
    expect(schema.required).toEqual(Object.keys(schema.properties as object))
    const properties = schema.properties as { segments: { items: { properties: Record<string, unknown>; required: string[] } } }
    expect(properties.segments.items.required).toEqual(Object.keys(properties.segments.items.properties))
    expect(properties.segments.items.properties).not.toHaveProperty('speaker')
    harness.stop()
  })
})

describe('OpenRouter audio adapter', () => {
  it('rejects an oversized body as permanent even when reader cancellation rejects', async () => {
    const fetch = vi.fn<OpenRouterKeyFetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
      cancel() { return Promise.reject(new Error('cancel failed')) },
    })))
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model(), log: () => {} })
    await expect(adapter.text('large', signal())).rejects.toMatchObject({ code: 'too-large', permanent: true })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retries an unsupported optional parameter once without optional parameters, keeping JSON instructions', async () => {
    const rootPath = await root(), bodies: Record<string, unknown>[] = []
    await writeFile(join(rootPath, 'audio.wav'), Buffer.alloc(44 + 32_000))
    const fetch: OpenRouterKeyFetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length === 1) return answer({ error: { type: 'invalid_request_error', message: 'unsupported parameter response_format' } }, 400)
      return answer({ choices: [{ message: { content: JSON.stringify({ segments: [] }) } }] })
    }
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model({ supported_parameters: ['structured_outputs', 'reasoning', 'temperature'] }), log: () => {} })
    await expect(adapter.transcribe({ directory: rootPath, language: undefined, instructions: '', prompt: '', signal: signal() })).resolves.toBe(JSON.stringify({ segments: [] }))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toHaveProperty('response_format')
    for (const optional of ['response_format', 'reasoning', 'temperature']) expect(bodies[1]).not.toHaveProperty(optional)
    const content = (bodies[1].messages as Array<{ content: Array<{ text?: string }> }>)[0].content[0].text
    expect(content).toContain('Return only one JSON object matching')
  })

  it('validates model lookup identity and merges missing recommended seed capabilities', async () => {
    const rootPath = await root(), bodies: Record<string, unknown>[] = []
    await writeFile(join(rootPath, 'audio.wav'), Buffer.alloc(44 + 32_000))
    const modelCache = {
      schema: 1, fetchedAt: Date.now() - 25 * 60 * 60 * 1000, text: [model({
        architecture: { input_modalities: [], output_modalities: [] }, pricing: {}, context_length: undefined,
        supported_parameters: [], reasoning: undefined, top_provider: {},
      })],
      stt: [model({ id: 'other/stt', architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] }, endpoints: ['/api/v1/audio/transcriptions'] })], probes: {},
    }
    await writeFile(join(rootPath, 'openrouter-models.json'), JSON.stringify(modelCache))
    const fetch: OpenRouterKeyFetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return answer({ choices: [{ message: { content: 'ok' } }] }) }
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch, userData: rootPath, lookupModel: async () => model({ id: 'wrong/model' }), log: () => {} })
    await adapter.transcribe({ directory: rootPath, language: undefined, instructions: '', prompt: '', signal: signal() })
    expect(bodies[0].reasoning).toEqual({ effort: 'medium' })
    expect(bodies[0].temperature).toBe(0)
    expect(bodies[0]).toHaveProperty('response_format')
    await writeFile(join(rootPath, 'openrouter-models.json'), JSON.stringify({ ...modelCache, fetchedAt: Date.now(), text: [model({ supported_parameters: [], reasoning: undefined, top_provider: {} })] }))
    await adapter.transcribe({ directory: rootPath, language: undefined, instructions: '', prompt: '', signal: signal() })
    expect(bodies[1].reasoning).toEqual({ effort: 'medium' })
    expect(bodies[1].temperature).toBe(0)
    expect(bodies[1]).toHaveProperty('response_format')
  })

  it('sends the exact WAV through chat, omits CLI file instructions, preserves vocabulary rules, and reaches parseTranscript', async () => {
    const rootPath = await root()
    const requests: Record<string, unknown>[] = []
    const fetch: OpenRouterKeyFetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return answer({ id: 'audio-1', choices: [{ message: { content: JSON.stringify({ language: 'ru', error: '', segments: [{ start: 0.25, end: 0.75, text: 'Обсудили план.' }] }) } }], usage: { cost: 0.002 } })
    }
    const adapter = createOpenRouter({ settings: settings({ transcriptionEffort: 'low' }), key: key(), fetch, lookupModel: async () => model() })
    const transcribe = createHarnessTranscriber({ settings: settings(), tempDir: rootPath, signal: signal(), transcribe: request => adapter.transcribe(request) }, {
      prompt: () => 'Ada and Zentric', language: () => 'ru', onLanguage: vi.fn(),
    })
    const samples = Float32Array.from({ length: 16_000 }, (_, i) => Math.sin(i / 13) * 0.2)
    const lines = await transcribe({ track: 'them', startMs: 2_000, samples, clearMs: 500 })
    expect(lines).toEqual([{ track: 'them', startMs: 2_250, endMs: 2_750, text: 'Обсудили план.' }])
    expect(requests).toHaveLength(1)
    const content = (requests[0].messages as Array<{ content: Array<{ type: string; text?: string; input_audio?: { data: string; format: string } }> }>)[0].content
    const text = content.find(part => part.type === 'text')?.text ?? ''
    expect(text).toContain('Names and vocabulary (context only; never invent speech from them): Ada and Zentric')
    expect(text).toContain('Return only one JSON object matching')
    expect(text).not.toContain('./audio.wav')
    expect(text).not.toContain('view_file')
    const audio = content.find(part => part.type === 'input_audio')?.input_audio
    expect(audio?.format).toBe('wav')
    expect(Buffer.from(audio?.data ?? '', 'base64')).toEqual(wavBytes(samples))
    expect(requests[0]).toMatchObject({
      model: 'google/gemini-3.8-flash',
      max_tokens: 20_000,
      response_format: { type: 'json_schema', json_schema: { name: 'transcript', strict: true } },
      reasoning: { effort: 'medium' },
      provider: { require_parameters: true, data_collection: 'deny' },
      stream: false,
    })
  })

  it('uses a local error for an unreadable staged WAV and does not call OpenRouter', async () => {
    const rootPath = await root(), fetch = vi.fn<OpenRouterKeyFetch>()
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model() })
    await expect(adapter.transcribe({ directory: rootPath, language: undefined, instructions: '', prompt: '', signal: signal() })).rejects.toMatchObject({ code: 'local-audio', permanent: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('passes the Stage 0 60-second raw body through the adapter and real transcript parser', async () => {
    const rootPath = await root()
    let requestBody!: Record<string, unknown>
    await writeFile(join(rootPath, 'audio.wav'), Buffer.alloc(44 + 32_000))
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return answer(await liveFixture('chat-60s.json'))
    }, lookupModel: async () => model({ top_provider: undefined }), log: () => {} })
    const raw = await adapter.transcribe({ directory: rootPath, language: 'ru', instructions: 'Keep the reference timestamps.', prompt: '', signal: signal() })
    const transcript = parseTranscript(raw, 60)
    expect(transcript.language).toBe('ru')
    expect(transcript.segments.length).toBeGreaterThan(0)
    expect(requestBody.max_tokens).toBe(48_000)
  })

  it('maps the Stage 0 max-token boundary to truncated even when the provider returns partial content', async () => {
    const rootPath = await root()
    await writeFile(join(rootPath, 'audio.wav'), Buffer.alloc(44 + 32_000))
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => answer(await liveFixture('chat-5m.json')), lookupModel: async () => model(), log: () => {} })
    await expect(adapter.transcribe({ directory: rootPath, language: 'ru', instructions: '', prompt: '', signal: signal() })).rejects.toMatchObject({ code: 'truncated' })
  })

  it('drops the vocabulary line for a clear-speech batch under 300 ms', async () => {
    const rootPath = await root(), bodies: Record<string, unknown>[] = []
    const fetch: OpenRouterKeyFetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return answer({ choices: [{ message: { content: JSON.stringify({ segments: [] }) } }] }) }
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model() })
    const transcribe = createHarnessTranscriber({ settings: settings(), tempDir: rootPath, signal: signal(), transcribe: request => adapter.transcribe(request) }, {
      prompt: () => 'This vocabulary must not be sent', language: () => undefined, onLanguage: vi.fn(),
    })
    await transcribe({ track: 'me', startMs: 0, samples: new Float32Array(8_000), clearMs: 299 })
    const content = ((bodies[0].messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0].content).find(part => part.type === 'text')?.text ?? ''
    expect(content).not.toContain('Names and vocabulary')
  })
})

describe('OpenRouter errors and retries', () => {
  it('keeps unsupported optional-parameter 400s eligible for automatic recovery', () => {
    expect(classifyOpenRouterError(400, { error: { type: 'invalid_request_error', message: 'unsupported parameter response_format' } })).toMatchObject({ code: 'bad-response', permanent: false })
  })

  it.each([
    ['finish reason', { choices: [{ finish_reason: 'content_filter', message: { content: 'blocked' } }] }],
    ['native finish reason', { choices: [{ native_finish_reason: 'content_filter', message: { content: 'blocked' } }] }],
    ['refusal', { choices: [{ message: { refusal: 'blocked' } }] }],
  ])('marks a 200 %s response as permanent moderation', async (_name, body) => {
    const fetch = vi.fn<OpenRouterKeyFetch>(async () => answer(body))
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model(), sleep: async () => {} })
    await expect(adapter.text('moderated', signal())).rejects.toMatchObject({ code: 'moderation', permanent: true })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('keeps the timeout active after headers arrive until the body finishes', async () => {
    vi.useFakeTimers()
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetch: OpenRouterKeyFetch = async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; init?.signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }) } })
      return new Response(stream, { status: 200 })
    }
    const adapter = createOpenRouter({ settings: settings({ timeoutSeconds: 10 }), key: key(), fetch, lookupModel: async () => model(), sleep: async () => {} })
    const pending = adapter.text('body stall', signal())
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.waitFor(() => expect(bodyController).toBeDefined())
    await vi.runAllTimersAsync()
    await assertion
    expect(bodyController).toBeDefined()
  })
  it.each([
    [401, { error: { type: 'invalid_api_key' } }, 'auth'],
    [402, { error: { metadata: { limit_source: 'openrouter_credits' } } }, 'credits'],
    [402, { error: { metadata: { limit_source: 'openrouter_in_flight_budget' } } }, 'rate-limit'],
    [403, { error: { metadata: { limit_source: 'openrouter_key_limit' } } }, 'budget'],
    [403, { error: { metadata: { reasons: ['safety'] } } }, 'moderation'],
    [404, { error: { type: 'not_found' } }, 'model-gone'],
    [404, { error: { type: 'provider_unavailable' } }, 'no-provider'],
    [429, { error: { type: 'rate_limit' } }, 'rate-limit'],
    [502, { error: { type: 'provider_unavailable' } }, 'unavailable'],
    [503, { error: { type: 'provider_overloaded' } }, 'unavailable'],
    [503, { error: { type: 'no_provider' } }, 'no-provider'],
    [504, { error: { type: 'timeout' } }, 'timeout'],
    [413, { error: { type: 'payload_too_large' } }, 'too-large'],
    [200, { error: { type: 'moderation' } }, 'moderation'],
  ] as const)('classifies raw response %s as %s through the adapter', async (status, body, code) => {
    const fetch: OpenRouterKeyFetch = async () => answer(body, status)
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model(), sleep: async () => {} })
    await expect(adapter.text('error case', signal())).rejects.toMatchObject({ code })
  })

  it('retries 429 once after Retry-After, never retries 401, and caps 503 at two retries', async () => {
    const sleeps: number[] = []
    const retryFetch = vi.fn<OpenRouterKeyFetch>()
      .mockResolvedValueOnce(answer({ error: { type: 'rate_limit' } }, 429, { 'Retry-After': '3' }))
      .mockResolvedValueOnce(answer({ choices: [{ message: { content: 'ok' } }] }))
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: retryFetch, lookupModel: async () => model(), sleep: async ms => { sleeps.push(ms) } })
    await expect(adapter.text('retry', signal())).resolves.toBe('ok')
    expect(retryFetch).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([3_000])

    const authFetch = vi.fn<OpenRouterKeyFetch>(async () => answer({ error: { type: 'invalid_api_key' } }, 401))
    const authAdapter = createOpenRouter({ settings: settings(), key: key(), fetch: authFetch, lookupModel: async () => model(), sleep: async ms => { sleeps.push(ms) } })
    await expect(authAdapter.text('auth', signal())).rejects.toMatchObject({ code: 'auth' })
    expect(authFetch).toHaveBeenCalledOnce()

    const unavailableFetch = vi.fn<OpenRouterKeyFetch>(async () => answer({ error: { type: 'provider_overloaded' } }, 503))
    const unavailableAdapter = createOpenRouter({ settings: settings(), key: key(), fetch: unavailableFetch, lookupModel: async () => model(), sleep: async ms => { sleeps.push(ms) } })
    await expect(unavailableAdapter.text('three failures', signal())).rejects.toMatchObject({ code: 'unavailable' })
    expect(unavailableFetch).toHaveBeenCalledTimes(3)
    expect(sleeps.slice(-2)).toEqual([2_000, 8_000])
  })

  it('never copies a key or response body into errors or structured logs', async () => {
    const logs: OpenRouterLogEntry[] = []
    const body = { id: 'gen-leak-test', error: { type: 'provider_unavailable', message: `Authorization: Bearer ${KEY}` } }
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => answer(body, 500), lookupModel: async () => model(), log: entry => logs.push(entry), sleep: async () => {} })
    const error = await adapter.text('never log this', signal()).catch(value => value as Error)
    expect(String(error)).not.toContain(KEY)
    expect(JSON.stringify(logs)).not.toContain(KEY)
    expect(JSON.stringify(logs)).not.toContain('Authorization')
    expect(JSON.stringify(logs)).toContain('provider_unavailable')
  })

  it('uses the Stage 0 error bodies and never logs user_id or an unrequested model name', async () => {
    const invalid = await liveFixture('error-invalid-key.json')
    const invalidAdapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => answer(invalid, 401), lookupModel: async () => model(), sleep: async () => {} })
    await expect(invalidAdapter.text('invalid key', signal())).rejects.toMatchObject({ code: 'auth' })

    const gone = await liveFixture('error-nonexistent-model.json')
    const logs: OpenRouterLogEntry[] = []
    const goneAdapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => answer(gone, 400), lookupModel: async () => model(), log: entry => logs.push(entry), sleep: async () => {} })
    await expect(goneAdapter.text('missing model', signal())).rejects.toMatchObject({ code: 'model-gone' })
    expect(JSON.stringify(logs)).not.toContain('user_')
    expect(JSON.stringify(logs)).not.toContain('yogurt/nonexistent-live-probe-2026')
    expect(JSON.stringify(logs)).toContain('google/gemini-3.8-flash')
  })

  it('treats the max_tokens=1 ZDR fixture as a genuine truncated response', async () => {
    const requests: Record<string, unknown>[] = []
    const adapter = createOpenRouter({ settings: settings({ openrouterDataPolicy: 'zdr' }), key: key(), fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return answer(await liveFixture('error-provider-zdr.json'))
    }, lookupModel: async () => model(), log: () => {} })
    await expect(adapter.text('ZDR boundary', signal())).rejects.toMatchObject({ code: 'truncated' })
    expect(requests[0].provider).toEqual({ zdr: true })
  })

  it('classifies null content without length as bad-response', async () => {
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => answer({ choices: [{ message: { content: null } }] }), lookupModel: async () => model(), log: () => {} })
    await expect(adapter.text('empty', signal())).rejects.toMatchObject({ code: 'bad-response' })
  })

  it.each([[429, 'rate-limit'], [502, 'unavailable']] as const)('keeps %s status semantics with an HTML body', async (status, code) => {
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => new Response('<html>gateway failure</html>', { status, headers: { 'Retry-After': '1' } }), lookupModel: async () => model(), sleep: async () => {} })
    await expect(adapter.text('html', signal())).rejects.toMatchObject({ code })
  })

  it.each([[429, 'rate-limit'], [502, 'unavailable']] as const)('keeps %s status semantics with an empty body', async (status, code) => {
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => new Response(null, { status, headers: { 'Retry-After': '1' } }), lookupModel: async () => model(), sleep: async () => {} })
    await expect(adapter.text('empty', signal())).rejects.toMatchObject({ code })
  })
})

describe('OpenRouter usage and spooled pipeline', () => {
  it('does not let a throwing problem-clear callback undo successful lines or resend a batch', async () => {
    const chunk: Chunk = { track: 'them', startMs: 0, samples: new Float32Array(16_000) }
    const saved: string[] = [], transcribe = vi.fn(async () => [{ track: 'them' as const, startMs: 0, endMs: 100, text: 'saved' }])
    const pipeline = createPipeline({ meetingId: 'clear-throw', batchMs: 1, transcribe, save: lines => saved.push(...lines.map(line => line.text)), emit: () => {}, onAiProblem: problem => { if (problem.code === null) throw new Error('window closed') } })
    pipeline.enqueue(chunk)
    await pipeline.finish()
    expect(saved).toEqual(['saved'])
    expect(transcribe).toHaveBeenCalledOnce()
  })

  it('does not retry permanent adapter errors in the real pipeline and shares the bounded retry budget for 429', async () => {
    const rootPath = await root()
    const chunk: Chunk = { track: 'them', startMs: 0, samples: new Float32Array(16_000) }
    for (const [code, status, body, blocked] of [
      ['auth', 401, { error: { type: 'invalid_api_key' } }, false],
      ['credits', 402, { error: { metadata: { limit_source: 'openrouter_credits' } } }, false],
      ['truncated', 200, { choices: [{ finish_reason: 'length', message: { content: null } }] }, true],
      ['too-large', 413, { error: { message: 'payload too large' } }, true],
    ] as const) {
      const spool = createSpool(spoolDirOf(join(rootPath, code))), fetch = vi.fn<OpenRouterKeyFetch>(async () => answer(body, status))
      const router = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model(), log: () => {} })
      const keyInSpool = spool.add(chunk)!
      const pipeline = createPipeline({ meetingId: code, batchMs: 1, spool, transcribe: async () => { await router.text('failure', signal()); return [] }, save: () => {}, emit: () => {} })
      pipeline.enqueue(chunk, keyInSpool); await pipeline.finish()
      expect(fetch).toHaveBeenCalledOnce()
      expect(spool.entries()[0]).toMatchObject({ attempts: blocked ? 0 : 1, ...(blocked ? { blocked: true } : {}) })
      if (!blocked) expect(spool.entries()[0]).not.toHaveProperty('blocked')
    }
    const spool = createSpool(spoolDirOf(join(rootPath, '429'))), fetch = vi.fn<OpenRouterKeyFetch>(async () => answer({ error: { type: 'rate_limit' } }, 429))
    const router = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model(), sleep: async () => {}, log: () => {} })
    const keyInSpool = spool.add(chunk)!
    const pipeline = createPipeline({ meetingId: '429', batchMs: 1, spool, transcribe: async () => { await router.text('429', signal()); return [] }, save: () => {}, emit: () => {} })
    pipeline.enqueue(chunk, keyInSpool); await pipeline.finish()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(spool.entries()[0]).toMatchObject({ attempts: 1 })
    expect(spool.entries()[0]).not.toHaveProperty('blocked')
    const laterChunk = spool.list()[0]
    const laterPipeline = createPipeline({ meetingId: '429', batchMs: 1, spool, transcribe: async () => [{ track: 'them', startMs: 0, endMs: 250, text: 'recovered automatically' }], save: () => {}, emit: () => {} })
    laterPipeline.enqueue(laterChunk, laterChunk.key)
    await laterPipeline.finish()
    expect(spool.hasEntries()).toBe(false)
  })

  it('emits a no-key problem once through the real pipeline without making an HTTP request', async () => {
    const rootPath = await root(), chunk: Chunk = { track: 'them', startMs: 0, samples: new Float32Array(16_000) }
    const fetch = vi.fn<OpenRouterKeyFetch>()
    const router = createOpenRouter({ settings: settings(), key: { read: async () => { throw new HarnessError('missing', 'no-key') } }, fetch, lookupModel: async () => model() })
    const spool = createSpool(spoolDirOf(join(rootPath, 'no-key'))), keyInSpool = spool.add(chunk)!
    const problems: AiProblemUpdate[] = []
    const pipeline = createPipeline({ meetingId: 'no-key', batchMs: 1, spool, transcribe: async () => { await router.text('no key', signal()); return [] }, save: () => {}, emit: () => {}, onAiProblem: problem => problems.push(problem) })
    pipeline.enqueue(chunk, keyInSpool); await pipeline.finish()
    expect(fetch).not.toHaveBeenCalled()
    expect(spool.entries()[0]).toMatchObject({ attempts: 1 })
    expect(spool.entries()[0]).not.toHaveProperty('blocked')
    expect(problems).toEqual([{ code: 'no-key', meetingId: 'no-key', track: 'them', model: 'google/gemini-3.8-flash' }])
  })

  it('stores only daily cost/audio aggregates and reports measured transcription hourly cost', async () => {
    const rootPath = await root(), clock = { at: Date.parse('2026-11-18T12:00:00Z') }
    const usage = createOpenRouterUsage({ userData: rootPath, now: () => clock.at })
    await usage.record({ model: 'google/gemini-3.8-flash', task: 'transcription', costUsd: 0.22, audioSeconds: 3_600 })
    await usage.record({ model: 'google/gemini-3.8-flash', task: 'text', costUsd: 0.08 })
    expect(await usage.summary()).toEqual({ todayUsd: 0.3, thirtyDayUsd: 0.3, transcriptionPerHourUsd: { 'google/gemini-3.8-flash': 0.22 }, transcriptionCostUnknown: false, textCostUnknown: false, missingCostCount: 0 })
    const stored = JSON.parse(await readFile(join(rootPath, 'openrouter-usage.json'), 'utf8')) as Record<string, unknown>
    expect(JSON.stringify(stored)).not.toContain('segments')
    expect(JSON.stringify(stored)).not.toContain('request')
    expect(JSON.stringify(stored)).not.toContain('response')
  })

  it('keeps a reported zero audio cost and flags it unknown for a paid model', async () => {
    const rootPath = await root(), now = Date.parse('2026-11-18T12:00:00Z')
    await writeFile(join(rootPath, 'audio.wav'), Buffer.alloc(44 + 32_000))
    const usage = createOpenRouterUsage({ userData: rootPath, now: () => now })
    const adapter = createOpenRouter({ settings: settings(), key: key(), fetch: async () => answer({ choices: [{ message: { content: JSON.stringify({ segments: [] }) } }], usage: { cost: 0 } }), lookupModel: async () => model(), usage, log: () => {} })
    await adapter.transcribe({ directory: rootPath, language: undefined, instructions: '', prompt: '', signal: signal() })
    const stored = JSON.parse(await readFile(join(rootPath, 'openrouter-usage.json'), 'utf8')) as { days: Record<string, { costUsd: number; transcriptionCostUnknown: boolean; models: Record<string, { transcriptionCostUnknown: boolean }> }> }
    const day = stored.days[openRouterLocalDateKey(now)]
    expect(day.costUsd).toBe(0)
    expect(day.transcriptionCostUnknown).toBe(true)
    expect(day.models['google/gemini-3.8-flash'].transcriptionCostUnknown).toBe(true)
  })

  it('keeps text cost uncertainty separate and only suppresses measured audio prices for recent transcription uncertainty', async () => {
    const rootPath = await root(), clock = { at: Date.parse('2026-11-18T12:00:00Z') }
    const usage = createOpenRouterUsage({ userData: rootPath, now: () => clock.at })
    await usage.record({ model: 'google/gemini-3.8-flash', task: 'transcription', costUsd: 0.22, audioSeconds: 3_600 })
    await usage.record({ model: 'google/gemini-3.8-flash', task: 'text', costUsd: 0, costMissing: true })
    expect(await usage.summary()).toMatchObject({ textCostUnknown: true, transcriptionCostUnknown: false, transcriptionPerHourUsd: { 'google/gemini-3.8-flash': 0.22 } })
    await usage.record({ model: 'google/gemini-3.8-flash', task: 'transcription', costUsd: 0, audioSeconds: 60, costUnknown: true })
    expect(await usage.summary()).toMatchObject({ transcriptionCostUnknown: true, transcriptionPerHourUsd: {} })
    clock.at += 31 * 24 * 60 * 60 * 1_000
    expect(await usage.summary()).toMatchObject({ transcriptionCostUnknown: false, textCostUnknown: false })
    expect((await usage.summary()).transcriptionPerHourUsd['google/gemini-3.8-flash']).toBeCloseTo(0.22 / (3_660 / 3_600), 6)
  })

  it('keeps a credits-failed remote batch on disk, then removes it after a successful recovery', async () => {
    const rootPath = await root(), meeting = join(rootPath, 'meeting'), spool = createSpool(spoolDirOf(meeting))
    const bodies: unknown[] = []
    const fetch = vi.fn<OpenRouterKeyFetch>()
      .mockResolvedValueOnce(answer({ error: { metadata: { limit_source: 'openrouter_credits' } } }, 402))
      .mockResolvedValueOnce(answer({ error: { metadata: { limit_source: 'openrouter_credits' } } }, 402))
      .mockResolvedValueOnce(answer({ error: { metadata: { limit_source: 'openrouter_credits' } } }, 402))
    const router = createOpenRouter({ settings: settings(), key: key(), fetch, lookupModel: async () => model(), sleep: async () => {}, log: () => {} })
    const transcriber = createHarnessTranscriber({ settings: settings(), tempDir: join(rootPath, 'stage'), signal: signal(), transcribe: request => router.transcribe(request) }, {
      prompt: () => '', language: () => undefined, onLanguage: vi.fn(),
    })
    const chunk: Chunk = { track: 'them', startMs: 0, samples: new Float32Array(16_000), clearMs: 1_000 }
    const saved: string[] = []
    const problems: AiProblemUpdate[] = []
    const pipeline = createPipeline({ meetingId: 'm1', batchMs: 60_000, spool, transcribe: async c => { bodies.push(c); return transcriber(c) }, save: lines => saved.push(...lines.map(line => line.text)), emit: () => {}, onAiProblem: problem => problems.push(problem) })
    pipeline.enqueue(chunk, spool.add(chunk))
    const failed = pipeline.finish()
    await failed
    expect(saved).toEqual([])
    expect(spool.hasEntries()).toBe(true)
    expect(spool.entries()[0]).toMatchObject({ attempts: 1 })
    expect(spool.entries()[0]).not.toHaveProperty('blocked')
    expect(problems).toEqual([{ code: 'credits', meetingId: 'm1', track: 'them', model: 'google/gemini-3.8-flash' }])

    const goodFetch: OpenRouterKeyFetch = async () => answer({ choices: [{ message: { content: JSON.stringify({ segments: [{ start: 0, end: 0.5, text: 'После пополнения.' }] }) } }] })
    const goodRouter = createOpenRouter({ settings: settings(), key: key(), fetch: goodFetch, lookupModel: async () => model(), log: () => {} })
    const goodTranscriber = createHarnessTranscriber({ settings: settings(), tempDir: join(rootPath, 'stage2'), signal: signal(), transcribe: request => goodRouter.transcribe(request) }, {
      prompt: () => '', language: () => undefined, onLanguage: vi.fn(),
    })
    const recovered = spool.list()[0]
    const recoveredPipeline = createPipeline({ meetingId: 'm1', batchMs: 1, spool, transcribe: async c => goodTranscriber(c), save: lines => saved.push(...lines.map(line => line.text)), emit: () => {}, onAiProblem: problem => problems.push(problem) })
    recoveredPipeline.enqueue(recovered, recovered.key)
    await recoveredPipeline.finish()
    expect(saved).toEqual(['После пополнения.'])
    expect(spool.hasEntries()).toBe(false)
    expect(bodies).toHaveLength(1)
    expect(problems.at(-1)).toMatchObject({ code: null, meetingId: 'm1', track: 'them' })
  })

  it('aborts a long request through harness.stop and leaves the batch spooled', async () => {
    const rootPath = await root(), started = vi.fn()
    const fetch: OpenRouterKeyFetch = async (_url, init) => {
      started()
      const stream = new ReadableStream<Uint8Array>({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }) } })
      return new Response(stream, { status: 200 })
    }
    const harness = createSubscriptionHarness({ settings: settings(), tempDir: join(rootPath, 'stage'), openrouter: { key: key(), fetch, lookupModel: async () => model(), log: () => {} } })
    const spool = createSpool(spoolDirOf(join(rootPath, 'meeting')))
    const transcriber = harness.transcriber({ prompt: () => '', language: () => undefined, onLanguage: vi.fn() })
    const chunk: Chunk = { track: 'them', startMs: 0, samples: new Float32Array(16_000), clearMs: 1_000 }
    const spoolKey = spool.add(chunk)!
    const pipeline = createPipeline({ meetingId: 'abort', batchMs: 1, spool, transcribe: async c => transcriber(c), save: () => {}, emit: () => {} })
    pipeline.enqueue(chunk, spoolKey)
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
    harness.stop()
    await pipeline.finish()
    expect(spool.hasEntries()).toBe(true)
  })
})
