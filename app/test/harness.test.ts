import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_AI_SETTINGS, type AiSettings } from '../src/shared/ai'
import { agyAnswer, createAgy } from '../src/main/harness/agy'
import { checkHarness, createSubscriptionHarness } from '../src/main/harness'
import { countTokens } from '../src/main/harness/model'
import { createPorch, exactProfile, porchInstallation } from '../src/main/harness/porch'
import { executablePath, HarnessError, HarnessProcesses, inStage } from '../src/main/harness/process'
import { childEnvironment } from '../src/main/childEnv'
import { createHarnessTranscriber, parseTranscript, parseTranscriptDetailed, TRANSCRIPT_SCHEMA, type AudioRequest } from '../src/main/harness/transcribe'
import { keepRejectedResponse, REJECTED_RESPONSE_MAX_AGE_MS, REJECTED_RESPONSE_MAX_BYTES, REJECTED_RESPONSE_MAX_FILES } from '../src/main/harness/rejectedResponses'
import { takeBatch } from '../src/main/asr/batch'
import { chunker, type Chunk } from '../src/main/asr/chunker'
import { wavBytes } from '../src/main/asr/transcribe'
import { enhance, partBudget, splitForContext, summaryPrompt, type Llm } from '../src/main/notes/enhance'

const roots: string[] = []
const stoppers: Array<() => void> = []
it('scrubs both OpenRouter key variables from every child environment', () => {
  expect(childEnvironment({ OPENROUTER_API_KEY: 'fake', YOGURT_OPENROUTER_API_KEY: 'fake', PATH: '/bin' })).toEqual({ PATH: '/bin' })
})
it('preserves the original harness failure when staging cleanup also fails', async () => {
  const root = await directory()
  const failure = new HarnessError('oversized', 'too-large', 1, undefined, true)
  let stage = ''
  await expect(inStage(root, undefined, async directory => { stage = directory; throw failure }, async () => { throw new Error('cleanup failed') })).rejects.toBe(failure)
  await rm(stage, { recursive: true, force: true })
})
afterEach(async () => {
  stoppers.splice(0).forEach(stop => stop())
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function directory() { const path = await mkdtemp(join(process.cwd(), '.harness-test-')); roots.push(path); return path }
async function script(directory: string, name: string, source: string) {
  const path = join(directory, `${name}.cjs`)
  await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o700 })
  await chmod(path, 0o700)
  return path
}
const successful = (response: string) => JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } })
const INIT = JSON.stringify({ event: 'init', conversation_id: '11111111-2222-4333-8444-555555555555', init: { model: 'fake' } })
const heard = { language: 'ru', segments: [{ start: 0.25, end: 1.5, text: 'Обсудили запуск в пятницу.' }] }
async function agyFixture(response: string | { summary: string; notes: string; nextSteps: string; title: string } = JSON.stringify(heard), result: Record<string, unknown> = {}) {
  const root = await directory(), log = join(root, 'calls.jsonl'), tempDir = join(root, 'staging')
  const agyPath = await script(root, 'fake-agy', `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args}) + '\\n'); console.log('agy 1.5.4'); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const schemaIndex = args.indexOf('--json-schema');
  const audioPath = path.join(process.cwd(), 'audio.wav');
  const call = {args, cwd:process.cwd(), input:JSON.parse(input), audio:fs.existsSync(audioPath) ? Array.from(fs.readFileSync(audioPath).subarray(0,44)) : null,
    schema:schemaIndex < 0 ? null : JSON.parse(fs.readFileSync(args[schemaIndex+1], 'utf8')),
    env: {GEMINI_API_KEY: 'GEMINI_API_KEY' in process.env, GOOGLE_API_KEY: 'GOOGLE_API_KEY' in process.env, AGY_ADC_AUTH: 'AGY_ADC_AUTH' in process.env, YOGURT_OPENROUTER_API_KEY: 'YOGURT_OPENROUTER_API_KEY' in process.env}};
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + '\\n');
  const answers = ${JSON.stringify(response)};
  const messages = typeof answers === 'string' ? [] : JSON.parse(call.input.message.content.split('\\n\\n').find(part => part.startsWith('{"messages":'))).messages;
  const latest = messages.at(-1)?.content ?? '';
  const response = typeof answers === 'string' ? answers : latest.startsWith('Now give this meeting a title') ? answers.title
    : latest.startsWith('Now write only') ? answers.nextSteps : latest.includes('Write compact notes on this part only') ? answers.summary : answers.notes;
  console.log(${JSON.stringify(INIT)});
  console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'UNTRUSTED PARTIAL'}}));
  console.log(JSON.stringify({event:'step_update',step_update:{thinking_delta:'PRIVATE THOUGHT'}}));
  console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response,...${JSON.stringify(result)}}}));
});`)
  const settings: AiSettings = { ...DEFAULT_AI_SETTINGS, agyPath }
  const harness = createSubscriptionHarness({ settings, tempDir, storeRoot: join(root, 'agy-store') })
  stoppers.push(harness.stop)
  return { root, log, tempDir, settings, harness, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}
const callbacks = () => ({ prompt: () => '', language: () => undefined as string | undefined, onLanguage: vi.fn() })
const RATE = 16_000
const chunk = () => ({ track: 'them' as const, startMs: 12_000, samples: new Float32Array(32_000) })
const isWindows = process.platform === 'win32'

describe('agy final-answer contract', () => {
  it('scrubs the launch OpenRouter key from an agy child environment', async () => {
    vi.stubEnv('YOGURT_OPENROUTER_API_KEY', `sk-or-v1-${'abcdef0123456789'.repeat(4)}`)
    const fixture = await agyFixture('answer')
    const llm = await fixture.harness.model.llm()
    await llm.chat('ping', () => {})
    expect((await fixture.calls()).at(-1)?.env.YOGURT_OPENROUTER_API_KEY).toBe(false)
  })

  it('takes exactly the authoritative response, never deltas, thoughts, tools, or diagnostics', () => {
    expect(agyAnswer(JSON.stringify({ event: 'step_update', step_update: { text_delta: 'wrong', thinking_delta: 'secret' } }) + '\n' + successful('Верный ответ'))).toBe('Верный ответ')
  })
  it.each([
    JSON.stringify({ event: 'result', result: { status: 'ERROR', response: 'private transcript' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'private transcript', finished_reason: 'interrupted' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', error: 'private transcript' } }),
    successful('   '), '', '{}', 'private transcript', successful('one') + '\n' + successful('two'),
  ])('rejects incomplete or failed results without exposing provider text (%#)', output => {
    expect(() => agyAnswer(output)).toThrow()
    try { agyAnswer(output) } catch (error) { expect(String(error)).not.toContain('private transcript') }
  })

  it('classifies a failed agy result as a retryable CLI failure without exposing diagnostics', () => {
    const failed = JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'private account detail' } })
    try { agyAnswer(failed); throw new Error('expected failure') }
    catch (error) {
      expect(error).toMatchObject({ code: 'cli-failed', permanent: false, cli: 'agy' })
      expect(String(error)).not.toContain('private account detail')
    }
  })

  it('classifies malformed agy output as a retryable model output error', () => {
    try { agyAnswer('not an event') ; throw new Error('expected failure') }
    catch (error) { expect(error).toMatchObject({ code: 'bad-response', cli: 'agy' }); expect(error).not.toHaveProperty('permanent') }
  })
})

describe('transcript validation', () => {
  it('accepts real silence, and clamps only sub-millisecond duration rounding', () => {
    expect(parseTranscript('{"segments":[]}', 2)).toEqual({ segments: [] })
    expect(parseTranscript('{"segments":[{"start":0,"end":2.0005,"text":" Да. "}]}', 2).segments).toEqual([{ start: 0, end: 2, text: 'Да.' }])
  })
  it('clamps a small timestamp overshoot and sorts segments when disorder stays below the global error threshold', () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({ start: i * 5, end: i * 5 + 1, text: `phrase ${i}` }))
    segments[0] = { start: 30, end: 45, text: 'later' }
    segments[1] = { start: 5, end: 61.5, text: 'early' }
    const result = parseTranscript(JSON.stringify({ segments }), 60).segments
    expect(result[0]).toEqual({ start: 5, end: 60, text: 'early' })
    expect(result[1]).toEqual({ start: 10, end: 11, text: 'phrase 2' })
    expect(result.find(segment => segment.text === 'later')).toEqual({ start: 30, end: 45, text: 'later' })
    expect(() => parseTranscript(JSON.stringify({ segments: [{ start: 0, end: 70, text: 'too far' }] }), 60)).toThrow('timestamps outside')
  })
  it('rejects mostly invalid output instead of masking a batch-wide timeline error', () => {
    const segments = Array.from({ length: 26 }, (_, i) => ({ start: i, end: i + 0.5, text: `анонимная реплика ${i}` }))
    for (const i of [3, 10, 17]) segments[i] = { start: 80 + i, end: 81 + i, text: `ошибка ${i}` }
    expect(() => parseTranscriptDetailed(JSON.stringify({ segments }), 61.8, { salvage: true })).toThrow(/timestamps outside/)
  })
  it('retries an empty answer when clear speech is substantial, but accepts a genuinely quiet batch', async () => {
    const tempDir = await directory(), calls: AudioRequest[] = []
    const transcriber = createHarnessTranscriber({ settings: DEFAULT_AI_SETTINGS, tempDir, signal: new AbortController().signal,
      transcribe: async request => {
        calls.push(request)
        return calls.length === 1 ? '{"segments":[]}' : JSON.stringify({ segments: [{ start: 0, end: 1, text: 'Длительная реплика.' }] })
      } }, callbacks())
    const clear = { track: 'me' as const, startMs: 0, samples: new Float32Array(16_000 * 30), clearMs: 20_000 }
    expect(await transcriber(clear)).toHaveLength(1)
    expect(calls).toHaveLength(2)

    calls.length = 0
    const quietTranscriber = createHarnessTranscriber({ settings: DEFAULT_AI_SETTINGS, tempDir, signal: new AbortController().signal,
      transcribe: async request => { calls.push(request); return '{"segments":[]}' } }, callbacks())
    expect(await quietTranscriber({ ...clear, clearMs: 19_999 })).toEqual([])
    expect(calls).toHaveLength(1)
  })
  it('keeps a within-tolerance overshoot from the first response without another provider call', async () => {
    const tempDir = await directory(), calls: AudioRequest[] = []
    const transcriber = createHarnessTranscriber({ settings: DEFAULT_AI_SETTINGS, tempDir, signal: new AbortController().signal,
      transcribe: async request => {
        calls.push(request)
        return JSON.stringify({ language: 'en', segments: [{ start: 59, end: 61.5, text: 'last phrase' }] })
      } }, callbacks())
    const result = await transcriber({ track: 'me', startMs: 0, samples: new Float32Array(60 * RATE) })
    expect(calls).toHaveLength(1)
    expect(result).toEqual([{ track: 'me', startMs: 59_000, endMs: 60_000, text: 'last phrase' }])
  })
  it('salvages one impossible segment and a slight overshoot only after a fresh model response', async () => {
    const tempDir = await directory(), calls: AudioRequest[] = []
    const valid = Array.from({ length: 26 }, (_, i) => ({ start: i * 2, end: i * 2 + 0.5, text: `анонимная реплика ${i}` }))
    valid[0] = { ...valid[0]!, end: 62.8 }
    valid[12] = { ...valid[12]!, start: 80, end: 81 }
    const transcriber = createHarnessTranscriber({ settings: DEFAULT_AI_SETTINGS, tempDir, signal: new AbortController().signal,
      transcribe: async request => {
        calls.push(request)
        return calls.length === 1 ? 'неполный ответ без объекта' : JSON.stringify({ language: 'ru', segments: valid })
      } }, callbacks())
    const result = await transcriber({ track: 'me', startMs: 0, samples: new Float32Array(Math.round(61.8 * RATE)), clearMs: 2700 })
    expect(calls).toHaveLength(2)
    expect(result).toHaveLength(25)
    expect(result[0]?.endMs).toBe(61_800)
    expect(result.some(line => line.startMs >= 80_000)).toBe(false)
  })
  it('accepts a BOM, prose and a fenced JSON object', () => {
    const response = '\ufeffHere is the transcript:\n```json\n{"language":"ru","segments":[{"start":0,"end":1,"text":"Привет."}]}\n```\nDone.'
    expect(parseTranscript(response, 2)).toEqual({ language: 'ru', segments: [{ start: 0, end: 1, text: 'Привет.' }] })
  })
  it.each([
    '{"segments":[{"start":-2.1,"end":1,"text":"secret"}]}',
    '{"segments":[{"start":1,"end":0.5,"text":"secret"}]}',
    '{"segments":[{"start":0,"end":5,"text":"secret"}]}',
    '{"segments":[{"start":0,"end":70,"text":"secret"}]}',
    '{"segments":[{"start":0,"end":1e999,"text":"secret"}]}',
    '{"segments":[{"start":"0","end":1,"text":"secret"}]}',
    '{"segments":[],"error":"secret"}', '{"segments":false}', 'secret',
  ])('rejects invalid transcription data without leaking it (%#)', output => {
    expect(() => parseTranscript(output, 2)).toThrow()
    try { parseTranscript(output, 2) } catch (error) { expect(String(error)).not.toContain('secret') }
  })
  it('strips backslashes around quoted names, keeps paths, and drops a segment left empty', async () => {
    const tempDir = await directory()
    const transcribe = createHarnessTranscriber({
      settings: DEFAULT_AI_SETTINGS, tempDir, signal: new AbortController().signal,
      transcribe: async () => JSON.stringify({ segments: [
        { start: 0, end: 0.5, text: 'сказал \\Бархатный дирижёр\\  и мы  ушли' },
        { start: 0.5, end: 1, text: '\\\\' },
        { start: 1, end: 1.5, text: 'обычная реплика' },
        { start: 1.5, end: 2, text: 'крикнул \\\\Медные куранты\\\\ тише' },
        { start: 2, end: 2.5, text: 'пакет \\ латунный горизонт \\ закрывает' },
        { start: 2.5, end: 3, text: 'сохранил C:\\проект\\файл' },
      ] }),
    }, callbacks())
    const clip = { track: 'them' as const, startMs: 12_000, samples: new Float32Array(16_000 * 4) }
    expect(await transcribe(clip)).toEqual([
      { track: 'them', startMs: 12_000, endMs: 12_500, text: 'сказал Бархатный дирижёр и мы ушли' },
      { track: 'them', startMs: 13_000, endMs: 13_500, text: 'обычная реплика' },
      { track: 'them', startMs: 13_500, endMs: 14_000, text: 'крикнул Медные куранты тише' },
      { track: 'them', startMs: 14_000, endMs: 14_500, text: 'пакет латунный горизонт закрывает' },
      { track: 'them', startMs: 14_500, endMs: 15_000, text: 'сохранил C:\\проект\\файл' },
    ])
  })
})

describe('private rejected response evidence', () => {
  it('keeps raw output only in a capped, private, expiring meeting spool folder', async () => {
    const tempDir = await directory(), now = Date.now()
    const name = `${'a'.repeat(32)}-attempt-1`
    const path = await keepRejectedResponse(tempDir, name, 'anonymized rejected response', now)
    expect(path).toBeTruthy()
    expect(await readFile(path!, 'utf8')).toBe('anonymized rejected response')
    expect((await stat(join(tempDir, 'rejected'))).mode & 0o777).toBe(0o700)
    expect((await stat(path!)).mode & 0o777).toBe(0o600)
    expect(await keepRejectedResponse(tempDir, `${'b'.repeat(32)}-attempt-1`, 'x'.repeat(REJECTED_RESPONSE_MAX_BYTES + 1), now)).toBeUndefined()

    for (let i = 0; i < REJECTED_RESPONSE_MAX_FILES; i++) {
      await keepRejectedResponse(tempDir, `${i.toString(16).padStart(32, '0')}-attempt-1`, `response ${i}`, now)
    }
    await keepRejectedResponse(tempDir, `${'c'.repeat(32)}-attempt-2`, 'new response', now)
    expect((await readdir(join(tempDir, 'rejected'))).filter(file => file.endsWith('.txt'))).toHaveLength(REJECTED_RESPONSE_MAX_FILES)
    const old = new Date(now - REJECTED_RESPONSE_MAX_AGE_MS - 1000)
    for (const file of await readdir(join(tempDir, 'rejected'))) await utimes(join(tempDir, 'rejected', file), old, old)
    await keepRejectedResponse(tempDir, `${'d'.repeat(32)}-attempt-1`, 'fresh response', now + REJECTED_RESPONSE_MAX_AGE_MS + 1)
    expect((await readdir(join(tempDir, 'rejected'))).filter(file => file.endsWith('.txt'))).toEqual([`${'d'.repeat(32)}-attempt-1.txt`])
  })
})

describe('packed batch segment times', () => {
  /** two 1 s parts with a 60 s meeting pause between them: packed as 1 s + 1 s of zeros + 1 s */
  const parts = [
    { atMs: 0, startMs: 10_000, durationMs: 1000 },
    { atMs: 2000, startMs: 60_000, durationMs: 1000 },
  ]
  const packed = (): Chunk => ({ track: 'them', startMs: 10_000, samples: new Float32Array(48_000), parts })
  const hear = async (segments: Array<{ start: number; end: number; text: string }>, c: Chunk = packed()) => {
    const tempDir = await directory()
    const transcribe = createHarnessTranscriber({
      settings: DEFAULT_AI_SETTINGS, tempDir, signal: new AbortController().signal,
      transcribe: async () => JSON.stringify({ segments }),
    }, callbacks())
    return transcribe(c)
  }

  it('pins a segment inside a compressed pause to the previous part\'s end instead of inverting', async () => {
    // packed 1.3–1.7 s sits in the compressed gap: the start would snap to part 2, the end back to part 1
    expect(await hear([
      { start: 0.2, end: 0.8, text: 'В первой части.' },
      { start: 1.3, end: 1.7, text: 'В сжатой паузе.' },
      { start: 2.2, end: 2.8, text: 'Во второй части.' },
    ])).toEqual([
      { track: 'them', startMs: 10_200, endMs: 10_800, text: 'В первой части.' },
      { track: 'them', startMs: 11_000, endMs: 11_000, text: 'В сжатой паузе.' },
      { track: 'them', startMs: 60_200, endMs: 60_800, text: 'Во второй части.' },
    ])
  })

  it('keeps a zero-length segment exactly at a part boundary ordered', async () => {
    // packed 1.0 s is the first zero of the compressed gap: start snaps forward, end snaps back
    expect(await hear([{ start: 1.0, end: 1.0, text: 'На границе.' }])).toEqual([
      { track: 'them', startMs: 11_000, endMs: 11_000, text: 'На границе.' },
    ])
  })

  it('maps a chunk from a real takeBatch through the harness transcriber', async () => {
    const one = new Float32Array(16_000)
    const queue: Chunk[] = [
      { track: 'them', startMs: 5_000, samples: one, clearMs: 1000 },
      { track: 'them', startMs: 66_000, samples: one, clearMs: 1000 },
    ]
    const batch = takeBatch(queue, 300_000)!
    expect(batch.parts).toHaveLength(2)
    expect(await hear([
      { start: 0.2, end: 0.8, text: 'Первая часть.' },
      { start: 1.3, end: 1.7, text: 'В паузе.' },
      { start: 2.2, end: 2.8, text: 'Вторая часть.' },
    ], batch)).toEqual([
      { track: 'them', startMs: 5_200, endMs: 5_800, text: 'Первая часть.' },
      { track: 'them', startMs: 6_000, endMs: 6_000, text: 'В паузе.' },
      { track: 'them', startMs: 66_200, endMs: 66_800, text: 'Вторая часть.' },
    ])
  })
})

describe.skipIf(isWindows)('native agy adapter with a fake executable', () => {
  it('stages a real WAV, pins Gemini Flash medium, uses native reads, offsets Russian speech and cleans up', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'never forward this')
    vi.stubEnv('GOOGLE_API_KEY', 'never forward this either')
    vi.stubEnv('AGY_ADC_AUTH', 'true')
    const fixture = await agyFixture(), cb = callbacks()
    cb.language = () => 'ru'; cb.prompt = () => 'Родион, Yogurt'
    const result = await fixture.harness.transcriber(cb)(chunk())
    expect(result).toEqual([{ track: 'them', startMs: 12_250, endMs: 13_500, text: heard.segments[0].text }])
    expect(cb.onLanguage).toHaveBeenCalledWith('them', 'russian', heard.segments[0].text.length, true)
    const [call] = await fixture.calls()
    const arg = (name: string) => call.args[call.args.indexOf(name) + 1]
    expect(arg('--model')).toBe('gemini-3.8-flash'); expect(arg('--effort')).toBe('medium')
    expect(call.args).not.toContain('--dangerously-skip-permissions')
    expect(JSON.parse(arg('--settings'))).toMatchObject({ agentMode: '', toolPermission: 'request-review', modelProvider: '', useG1Credits: false,
      permissions: { deny: ['command(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)'] } })
    expect(call.env).toEqual({ GEMINI_API_KEY: false, GOOGLE_API_KEY: false, AGY_ADC_AUTH: false, YOGURT_OPENROUTER_API_KEY: false })
    const audio = Buffer.from(call.audio)
    expect(audio.toString('ascii', 0, 4)).toBe('RIFF'); expect(audio.readUInt32LE(24)).toBe(16_000); expect(audio.readUInt32LE(40)).toBe(64_000)
    expect(call.schema.required).toEqual(['segments'])
    expect(call.input.message.content).toContain('view_file / read_file')
    expect(call.input.message.content).toContain('Expected spoken language: ru')
    expect(call.input.message.content).toContain('Родион, Yogurt')
    expect(call.cwd).not.toBe(process.cwd()); expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('maps a packed batch\'s segment times back onto the meeting clock of each part', async () => {
    const fixture = await agyFixture(JSON.stringify({ language: 'ru', segments: [
      { start: 0.25, end: 0.5, text: 'Начало первой части.' },
      { start: 1.25, end: 1.75, text: 'Хвост второй части.' },
    ] }))
    const packed = { track: 'them' as const, startMs: 12_000, samples: new Float32Array(32_000),
      parts: [
        { atMs: 0, startMs: 12_000, durationMs: 1000 },
        { atMs: 1000, startMs: 62_000, durationMs: 1000 },
      ] }
    const result = await fixture.harness.transcriber(callbacks())(packed)
    expect(result).toEqual([
      { track: 'them', startMs: 12_250, endMs: 12_500, text: 'Начало первой части.' },
      { track: 'them', startMs: 62_250, endMs: 62_750, text: 'Хвост второй части.' },
    ])
  })
  it('gives audio requests at least 600 s while text keeps the configured timeout', async () => {
    const fixture = await agyFixture()
    const processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    const run = vi.spyOn(processes, 'run').mockResolvedValue({ stdout: `${INIT}\n${successful('ok')}`, stderr: '', exitCode: 0 })
    const dir = await directory()
    const agy = createAgy({ ...fixture.settings, timeoutSeconds: 180 }, processes, { storeRoot: join(fixture.root, 'agy-store') })
    await agy({ prompt: 'text request', directory: dir })
    await agy({ prompt: 'audio request', directory: dir, audio: true, schema: TRANSCRIPT_SCHEMA })
    expect(run.mock.calls.map(([options]) => options.timeoutMs)).toEqual([180_000, 600_000])
  })
  it('clamps a low transcription effort to medium at the agy boundary', async () => {
    const fixture = await agyFixture()
    const processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    const run = vi.spyOn(processes, 'run').mockResolvedValue({ stdout: `${INIT}\n${successful('ok')}`, stderr: '', exitCode: 0 })
    const agy = createAgy({ ...fixture.settings, transcriptionEffort: 'low' }, processes, { storeRoot: join(fixture.root, 'agy-store') })
    await agy({ prompt: 'audio request', directory: await directory(), audio: true, schema: TRANSCRIPT_SCHEMA })
    const options = run.mock.calls[0][0]
    expect(options.args[options.args.indexOf('--effort') + 1]).toBe('medium')
  })
  it('does not make remote requests or even create staging files for partial chunks', async () => {
    const fixture = await agyFixture()
    expect(await fixture.harness.transcriber(callbacks())(chunk(), { partial: true })).toEqual([])
    await expect(stat(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(fixture.tempDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('sends a chunk with almost no clear speech without the vocabulary line, and never skips audio', async () => {
    const fixture = await agyFixture(), cb = callbacks(), transcribe = fixture.harness.transcriber(cb)
    cb.prompt = () => 'Родион, Yogurt'
    const clip = (seconds: number, clearMs?: number): Chunk => ({ track: 'them', startMs: 12_000, samples: new Float32Array(seconds * 16_000), ...(clearMs === undefined ? {} : { clearMs }) })
    const heard_line = [{ track: 'them' as const, startMs: 12_250, endMs: 13_500, text: heard.segments[0].text }]
    // under 30 s with no clear speech: still sent — skipping it dropped real quiet speech — but without the vocabulary
    for (const c of [clip(10, 0), clip(40, 0)]) {
      expect(await transcribe(c)).toEqual(heard_line)
    }
    // at the 0.3 s clear-speech bound and with no clearMs at all: sent with the vocabulary as before
    for (const c of [clip(10, 300), clip(10)]) {
      expect(await transcribe(c)).toEqual(heard_line)
    }
    const calls = await fixture.calls()
    expect(calls).toHaveLength(4)
    const prompts = calls.map(call => call.input.message.content as string)
    for (const prompt of prompts.slice(0, 2)) {
      expect(prompt).not.toContain('Names and vocabulary')
      expect(prompt).not.toContain('Родион, Yogurt')
      expect(prompt).toContain('Transcribe the audio file ./audio.wav.')
    }
    expect(prompts[0]).toContain('The recording is exactly 10 seconds long')
    expect(prompts[1]).toContain('The recording is exactly 40 seconds long')
    for (const prompt of prompts.slice(2)) {
      expect(prompt).toContain('Names and vocabulary')
      expect(prompt).toContain('Родион, Yogurt')
    }
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('sends every chunk the chunker produces for far-field speech, the faint ones without the vocabulary', async () => {
    const RATE = 16_000
    const room = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.003 * Math.sqrt(2) * Math.sin(i * 1.3))
    const far = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.007 * Math.sqrt(2) * Math.sin(i / 10))
    const near = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.04 * Math.sqrt(2) * Math.sin(i / 10))
    const cat = (...xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
    const parts = [room(4), near(3), room(0.3), far(3), room(1), far(3), room(2), near(2), room(1)]
    const all = cat(...parts), out: Chunk[] = []
    const c = chunker(x => out.push(x))
    for (let i = 0; i < all.length; i += RATE / 10) c.push('them', i / 16, all.subarray(i, i + RATE / 10))
    c.flush()
    // the far-field stretch is a 3.2 s chunk with no clear speech: the removed gate used to drop it unsent
    expect(out.map(x => x.startMs)).toEqual([4000, 11300, 16300])
    expect(out.map(x => x.clearMs)).toEqual([3000, 0, 2000])
    expect(out[1].samples.length / RATE).toBeCloseTo(3.2, 1)
    const fixture = await agyFixture(), cb = callbacks()
    cb.prompt = () => 'Родион, Yogurt'
    const transcribe = fixture.harness.transcriber(cb)
    for (const queued of out) {
      expect(await transcribe(queued)).toEqual([{ track: 'them', startMs: queued.startMs + 250, endMs: queued.startMs + 1500, text: heard.segments[0].text }])
    }
    const calls = await fixture.calls()
    expect(calls).toHaveLength(out.length)
    const prompts = calls.map(call => call.input.message.content as string)
    expect(prompts[0]).toContain('Names and vocabulary')
    expect(prompts[1]).not.toContain('Names and vocabulary')
    expect(prompts[2]).toContain('Names and vocabulary')
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('accepts silence without a language callback', async () => {
    const fixture = await agyFixture('{"segments":[]}'), cb = callbacks()
    expect(await fixture.harness.transcriber(cb)(chunk())).toEqual([])
    expect(cb.onLanguage).not.toHaveBeenCalled()
  })
  it('fails a terminal error even after exit 0 and cleans temporary audio', async () => {
    const fixture = await agyFixture('PRIVATE TRANSCRIPT', { status: 'INTERRUPTED' })
    await expect(fixture.harness.transcriber(callbacks())(chunk())).rejects.toThrow('did not complete')
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('preserves before roles, Russian output preference and final callback consistency', async () => {
    const fixture = await agyFixture('## Решения\n- Запускаем в пятницу.\n')
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, outputLanguage: 'ru' }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    const llm = await harness.model.llm(), pieces: string[] = []
    expect(llm.readAhead).toBeUndefined()
    expect(await llm.count(['Hello', 'Привет'])).toEqual([5, 12])
    const before = ['Первый вопрос `$(touch should-not-run)`', 'Первый ответ']
    const answer = await llm.chat('Что дальше?', text => pieces.push(text), { before, maxTokens: 500 })
    expect(pieces.join('')).toBe(answer); expect(pieces).toHaveLength(1)
    const [call] = await fixture.calls()
    const request = call.input.message.content
    expect(request).toContain('headings in Russian')
    expect(JSON.parse(request.split('\n\n').find((part: string) => part.startsWith('{"messages":'))).messages).toEqual([
      { role: 'user', content: before[0] }, { role: 'assistant', content: before[1] }, { role: 'user', content: 'Что дальше?' },
    ])
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1])
    expect(settings.permissions.deny).toContain('read_file(*)')
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('places the explicitly chosen output language after any contradictory conversation instruction', async () => {
    const fixture = await agyFixture('Готово.')
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, outputLanguage: 'ru' }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    await (await harness.model.llm()).chat('Write the answer in English.', () => {})
    const [call] = await fixture.calls()
    const prompt = call.input.message.content
    expect(prompt.indexOf('overriding any contradictory language instructions')).toBeGreaterThan(prompt.indexOf('Write the answer in English.'))
  })
  it('rejects context and output overflow instead of silently truncating', async () => {
    expect(countTokens('Привет')).toBe(12)
    const fixture = await agyFixture('Ответ слишком длинный для одного токена')
    const llm = await fixture.harness.model.llm()
    await expect(llm.chat('я'.repeat(20_000), () => {})).rejects.toThrow('context budget')
    await expect(stat(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' })
    const token = vi.fn()
    await expect(llm.chat('Да?', token, { maxTokens: 1 })).rejects.toThrow('output budget')
    expect(token).not.toHaveBeenCalled(); expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('splits long Cyrillic, quotes and newlines against encoded budgets before summary completion', async () => {
    const fixture = await agyFixture('Краткое содержание.')
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, contextTokens: 8192 }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    const llm = await harness.model.llm()
    const estimate = (llm as typeof llm & { estimate: typeof countTokens }).estimate
    expect(llm.contextSize).toBe(6144)
    expect(estimate('"\\\nПривет')).toBe(Buffer.byteLength(JSON.stringify('"\\\nПривет'), 'utf8') - 2)
    const transcript = Array.from({ length: 180 }, (_, i) => `Родион: Задача ${i} — "проверить" путь C:\\проект и запуск в пятницу.`).join('\n')
    const budget = await partBudget(llm, 'Russian')
    const pieces = splitForContext(transcript, budget, estimate)
    expect(pieces.length).toBeGreaterThan(1)
    for (const [index, piece] of pieces.entries()) {
      expect(estimate(piece)).toBeLessThanOrEqual(budget)
      await expect(llm.chat(summaryPrompt(piece, index + 1, 'Russian'), () => {}, { summary: true, maxTokens: 700 })).resolves.toBe('Краткое содержание.')
    }
    expect(await fixture.calls()).toHaveLength(pieces.length)
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it.each([{ contextTokens: 8192, bullets: 24, nextSteps: false }, { contextTokens: 16_384, bullets: 12, nextSteps: true }])('completes long Russian enhance, follow-ups and title within a $contextTokens context', async ({ contextTokens, bullets, nextSteps }) => {
    const notes = '## Подготовка запуска\n' + Array.from({ length: bullets }, (_, i) => `- Этап ${i}: проверили "сборку", путь C:\\проект и готовность команды; запуск согласовали на пятницу.`).join('\n')
    const next = '## Следующие шаги\n- **Елена:** проверить сборку до пятницы.'
    const fixture = await agyFixture({ summary: '### Запуск\n- Команда проверила сборку и согласовала запуск на пятницу.', notes, nextSteps: next, title: 'Подготовка запуска к пятнице' })
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, contextTokens, outputLanguage: 'ru' }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    const llm = await harness.model.llm(), shown: string[] = []
    let title: ((llm: Llm) => Promise<string>) | undefined
    const segments = Array.from({ length: 220 }, (_, i) => ({ id: i, meetingId: 'russian-launch', track: i % 2 ? 'me' as const : 'them' as const,
      startMs: i * 1000, endMs: i * 1000 + 900, speaker: i % 2 ? null : 'Елена',
      text: `Этап ${i}: "проверить" C:\\проект и запуск в пятницу.\nДоговорились сохранить все изменения и проверить результат.` }))
    const md = await enhance({ meeting: { title: 'Подготовка запуска', attendees: [] }, mine: '', segments, language: 'ru', titleLater: ask => { title = ask } }, llm, text => shown.push(text))
    expect(md).toContain('## Подготовка запуска')
    expect(md.includes('## Следующие шаги')).toBe(nextSteps)
    expect(title).toBeTypeOf('function')
    expect(await title!(llm)).toBe('Подготовка запуска к пятнице')
    const calls = await fixture.calls()
    const conversations = calls.map(call => JSON.parse(call.input.message.content.split('\n\n').find((part: string) => part.startsWith('{"messages":'))).messages as Array<{ role: string; content: string }>)
    expect(conversations.filter(messages => messages.at(-1)!.content.includes('Write compact notes on this part only')).length).toBeGreaterThan(0)
    const followups = conversations.filter(messages => messages.at(-1)!.content.startsWith('Now write only'))
    expect(followups).toHaveLength(nextSteps ? 1 : 0)
    const original = conversations.find(messages => messages.length === 1 && messages[0].content.includes('Write the notes for this meeting'))!
    if (nextSteps) expect(followups[0].slice(0, 2)).toEqual([{ role: 'user', content: original[0].content }, { role: 'assistant', content: notes }])
    const titleMessages = conversations.at(-1)!
    expect(titleMessages.at(-1)!.content).toContain('Now give this meeting a title')
    expect(titleMessages).toHaveLength(nextSteps ? 3 : 1)
    if (nextSteps) expect(titleMessages.slice(0, 2)).toEqual(followups[0].slice(0, 2))
    expect(titleMessages.map(message => message.content).join('\n')).toContain(notes)
    expect(shown.join('')).not.toContain('Подготовка запуска к пятнице')
    for (const call of calls) {
      const request = call.input.message.content, output = Number(request.match(/Limit the answer to at most (\d+) tokens\./)[1])
      expect(Buffer.byteLength(request, 'utf8') + output + 256).toBeLessThanOrEqual(contextTokens)
    }
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('can retry a previously missing executable after it is installed', async () => {
    const fixture = await agyFixture('Установлено.')
    const missing = join(fixture.root, 'installed-later')
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, agyPath: missing }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    const llm = await harness.model.llm()
    await expect(llm.chat('Проверка', () => {})).rejects.toThrow('was not found')
    await symlink(fixture.settings.agyPath, missing)
    await expect(llm.chat('Проверка', () => {})).resolves.toBe('Установлено.')
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('aborts an active model request without final callbacks and removes its prompt stage', async () => {
    const fixture = await agyFixture(), abort = new AbortController(), ready = join(fixture.root, 'active')
    const binary = await script(fixture.root, 'waiting-agy', `console.log(${JSON.stringify(INIT)});require('node:fs').writeFileSync(${JSON.stringify(ready)},'1');process.stdin.resume();setInterval(()=>{},1000)`)
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, agyPath: binary }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    const llm = await harness.model.llm(abort.signal), callback = vi.fn()
    const result = llm.chat('Прервать этот запрос', callback).catch(error => error as Error)
    await vi.waitFor(async () => expect((await stat(ready)).size).toBe(1), { timeout: 1000, interval: 20 })
    abort.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(callback).not.toHaveBeenCalled(); expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('aborts before launch and prevents all future work after stop', async () => {
    const fixture = await agyFixture(), abort = new AbortController()
    abort.abort()
    await expect(fixture.harness.model.llm(abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    fixture.harness.stop()
    await expect(fixture.harness.transcriber(callbacks())(chunk())).rejects.toMatchObject({ name: 'AbortError' })
    await expect(stat(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('checks only a version, without requesting a model or authentication', async () => {
    const fixture = await agyFixture()
    expect(await checkHarness(fixture.settings)).toMatchObject({ ok: true })
    expect(await fixture.calls()).toEqual([{ args: ['--version'] }])
  })
})

const CONVERSATION = 'b32e1fb5-0eef-4b17-a4b9-d1408fed4f7b'
async function agyConversationFixture(mode: 'success' | 'failure' | 'hang' | 'stubborn' | 'noinit', settings: Partial<AiSettings> = {}) {
  const root = await directory(), store = join(root, 'agy-store'), ready = join(root, 'ready')
  const agyPath = await script(root, 'store-agy', `
const fs=require('node:fs'),path=require('node:path');
const id=${JSON.stringify(CONVERSATION)},store=${JSON.stringify(store)},ready=${JSON.stringify(ready)};
for(const [dir,name] of [['conversations',id+'.db'],['presence',id+'.lock'],['annotations',id+'.pbtxt']]){fs.mkdirSync(path.join(store,dir),{recursive:true});fs.writeFileSync(path.join(store,dir,name),'x')}
fs.mkdirSync(path.join(store,'brain',id),{recursive:true});fs.writeFileSync(path.join(store,'brain',id,'audio.wav'),'x');
fs.writeFileSync(ready,'1');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{
  ${mode === 'noinit' ? '' : "console.log(JSON.stringify({event:'init',conversation_id:id,init:{model:'fake'}}));"}
  ${mode === 'hang' ? "fs.writeFileSync(ready,'streamed');setInterval(()=>{},1000)"
    : mode === 'stubborn' ? "process.on('SIGTERM',()=>{});fs.writeFileSync(ready,'streamed');setInterval(()=>{},1000)"
    : mode === 'failure' ? "console.log(JSON.stringify({event:'result',result:{status:'ERROR',response:'PRIVATE FAILURE'}}));"
    : "console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'done'}}));"}
});`)
  const processes = new HarnessProcesses()
  stoppers.push(() => processes.stop())
  const agy = createAgy({ ...DEFAULT_AI_SETTINGS, agyPath, ...settings }, processes, { storeRoot: store, journalPath: join(root, 'agy-forget.json') })
  return { store, ready, agy, processes, directory: await directory() }
}
const storeEntries = (store: string, id: string) => [
  join(store, 'conversations', `${id}.db`), join(store, 'brain', id),
  join(store, 'presence', `${id}.lock`), join(store, 'annotations', `${id}.pbtxt`),
]

describe.skipIf(isWindows)('agy conversation cleanup on the direct route', () => {
  it('deletes the conversation copy after a successful request', async () => {
    const fixture = await agyConversationFixture('success')
    await expect(fixture.agy({ prompt: 'ping', directory: fixture.directory })).resolves.toBe('done')
    for (const path of storeEntries(fixture.store, CONVERSATION)) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('deletes the conversation copy after a failed answer', async () => {
    const fixture = await agyConversationFixture('failure')
    await expect(fixture.agy({ prompt: 'ping', directory: fixture.directory })).rejects.toThrow('did not complete')
    for (const path of storeEntries(fixture.store, CONVERSATION)) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('deletes the conversation copy after the harness stops a request in flight', async () => {
    const fixture = await agyConversationFixture('hang')
    const result = fixture.agy({ prompt: 'ping', directory: fixture.directory }).catch(error => error as Error)
    await vi.waitFor(async () => expect((await stat(fixture.ready)).size).toBe(8), { timeout: 1000, interval: 20 })
    // The init event precedes the ready marker in the child's output; let the parent consume it.
    await new Promise(resolve => setTimeout(resolve, 100))
    fixture.processes.stop()
    expect(await result).toMatchObject({ name: 'AbortError' })
    for (const path of storeEntries(fixture.store, CONVERSATION)) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('deletes the conversation copy when the timeout force-kills agy', async () => {
    const fixture = await agyConversationFixture('stubborn', { timeoutSeconds: 1 })
    await expect(fixture.agy({ prompt: 'ping', directory: fixture.directory })).rejects.toMatchObject({ name: 'TimeoutError' })
    for (const path of storeEntries(fixture.store, CONVERSATION)) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('warns and deletes nothing when agy never reports a conversation id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fixture = await agyConversationFixture('noinit')
    await expect(fixture.agy({ prompt: 'ping', directory: fixture.directory })).resolves.toBe('done')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('conversation id'))
    for (const path of storeEntries(fixture.store, CONVERSATION)) await expect(stat(path)).resolves.toBeTruthy()
  })
  it('prepends the resolved agy directory to the child PATH', async () => {
    const root = await directory(), seen = join(root, 'path')
    const agyPath = await script(root, 'path-agy', `
require('node:fs').writeFileSync(${JSON.stringify(seen)}, process.env.PATH);
process.stdin.resume();
process.stdin.on('end',()=>{console.log(${JSON.stringify(INIT)});console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ok'}}))});`)
    const processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    const agy = createAgy({ ...DEFAULT_AI_SETTINGS, agyPath }, processes, { storeRoot: join(root, 'agy-store'), journalPath: join(root, 'agy-forget.json') })
    await agy({ prompt: 'ping', directory: await directory() })
    expect((await readFile(seen, 'utf8')).split(delimiter)[0]).toBe(dirname(await realpath(agyPath)))
  })
})

async function seedAgyStore(store: string, id: string) {
  for (const [dir, name] of [['conversations', `${id}.db`], ['presence', `${id}.lock`], ['annotations', `${id}.pbtxt`]] as const) {
    await mkdir(join(store, dir), { recursive: true })
    await writeFile(join(store, dir, name), 'x')
  }
  await mkdir(join(store, 'brain', id), { recursive: true })
  await writeFile(join(store, 'brain', id, 'audio.wav'), 'x')
}

describe.skipIf(isWindows)('agy forget journal replay at harness creation', () => {
  const journaled = async (notBefore: number) => {
    const root = await directory(), store = join(root, 'agy-store'), tempDir = join(root, 'harness-tmp')
    const journal = join(tempDir, 'agy-forget.json')
    await mkdir(tempDir, { recursive: true })
    await seedAgyStore(store, CONVERSATION)
    await writeFile(journal, JSON.stringify([{ id: CONVERSATION, notBefore }]))
    const harness = createSubscriptionHarness({ settings: { ...DEFAULT_AI_SETTINGS, agyPath: join(root, 'missing-agy') }, tempDir, storeRoot: store })
    stoppers.push(harness.stop)
    return { store, journal }
  }
  it('deletes a conversation copy left behind by a killed run', async () => {
    const { store, journal } = await journaled(Date.now() - 60_000)
    await vi.waitFor(async () => {
      await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' })
    }, { timeout: 3000, interval: 20 })
    for (const path of storeEntries(store, CONVERSATION)) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not delete a journaled database older than its spawn', async () => {
    const { store, journal } = await journaled(Date.now() + 60_000)
    await vi.waitFor(async () => {
      await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' })
    }, { timeout: 3000, interval: 20 })
    for (const path of storeEntries(store, CONVERSATION)) await expect(stat(path)).resolves.toBeTruthy()
  })
})

describe.skipIf(isWindows)('bounded process lifecycle', () => {
  it('classifies missing, exited and timed out CLI processes', async () => {
    const root = await directory(), processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    await expect(executablePath(join(root, 'missing-agy'), 'agy')).rejects.toMatchObject({ code: 'cli-missing', permanent: true, cli: 'agy' })
    const fail = await script(root, 'fail-cli', `process.exit(1)`)
    await expect(processes.run({ label: 'Porch transcription', executable: fail, args: [], cwd: root, timeoutMs: 2000 }))
      .rejects.toMatchObject({ code: 'cli-failed', permanent: false, cli: 'Porch' })
    const hang = await script(root, 'hang-cli', `setInterval(() => {}, 1000)`)
    await expect(processes.run({ label: 'agy', executable: hang, args: [], cwd: root, timeoutMs: 30 }))
      .rejects.toMatchObject({ code: 'timeout', permanent: false, cli: 'agy', name: 'TimeoutError' })
  })
  it('preserves argv literally and reports nonzero failures without diagnostics', async () => {
    const root = await directory(), processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    const binary = await script(root, 'args', `console.log(JSON.stringify(process.argv.slice(2)));`)
    const args = ['a b', '`touch wrong`', '$(touch wrong)', '; exit 99']
    const result = await processes.run({ label: 'Fake', executable: binary, args, cwd: root, timeoutMs: 2000 })
    expect(JSON.parse(result.stdout)).toEqual(args)
    const fail = await script(root, 'fail', `console.error('PRIVATE TRANSCRIPT'); process.exit(7)`)
    await expect(processes.run({ label: 'Fake', executable: fail, args: [], timeoutMs: 2000 })).rejects.toThrow('exit 7')
  })
  it('bounds stdout, stderr and early closed input', async () => {
    const root = await directory(), processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    for (const stream of ['stdout', 'stderr']) {
      const binary = await script(root, `overflow-${stream}`, `process.${stream}.write('x'.repeat(65536)); setInterval(()=>{},1000)`)
      await expect(processes.run({ label: 'Fake', executable: binary, args: [], timeoutMs: 2000, stdoutLimit: 1024, stderrLimit: 1024 })).rejects.toThrow('size limit')
    }
    const early = await script(root, 'early', 'process.stdin.destroy(); process.exit(2)')
    await expect(processes.run({ label: 'Fake', executable: early, args: [], timeoutMs: 2000, input: 'x'.repeat(8 * 1024 * 1024) })).rejects.toThrow()
  })
  it('settles the run even when the stdout callback throws', async () => {
    const root = await directory(), processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const binary = await script(root, 'chatty', `console.log('one'); console.log('two')`)
    const result = await processes.run({ label: 'Fake', executable: binary, args: [], timeoutMs: 2000, onStdout: () => { throw new Error('callback bug') } })
    expect(result.stdout).toContain('one')
    expect(result.stdout).toContain('two')
    expect(warn).toHaveBeenCalled()
  })
  it('finds a bare executable name in ~/.local/bin when PATH lacks it, as under Finder', async () => {
    const root = await directory(), home = join(root, 'home'), bin = join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const binary = join(bin, 'agy')
    await writeFile(binary, `#!${process.execPath}\nprocess.exit(0)`, { mode: 0o700 })
    await chmod(binary, 0o700)
    vi.stubEnv('HOME', home)
    const found = await executablePath('agy', 'Fake agy', { PATH: join(root, 'empty-path') })
    expect(found).toBe(await realpath(binary))
  })
  it('uses env.HOME for ~/.local/bin when the passed environment provides it', async () => {
    const root = await directory(), home = join(root, 'home'), bin = join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const binary = join(bin, 'agy')
    await writeFile(binary, `#!${process.execPath}\nprocess.exit(0)`, { mode: 0o700 })
    await chmod(binary, 0o700)
    vi.stubEnv('HOME', join(root, 'other-home'))
    const found = await executablePath('agy', 'Fake agy', { HOME: home, PATH: join(root, 'empty-path') })
    expect(found).toBe(await realpath(binary))
  })
  it('times out and removes the private staging directory on failure', async () => {
    const root = await directory(), processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    const binary = await script(root, 'slow', 'setInterval(()=>{},1000)')
    const base = join(root, 'stage')
    await expect(inStage(base, processes.signal, cwd => processes.run({ label: 'Fake', executable: binary, args: [], cwd, timeoutMs: 50 }))).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(await readdir(base)).toEqual([])
  })
  it('kills descendants that ignore SIGTERM on abort before cleaning up', async () => {
    const root = await directory(), processes = new HarnessProcesses(), abort = new AbortController()
    stoppers.push(() => processes.stop())
    const beats = join(root, 'beats'), ready = join(root, 'ready')
    const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(beats)},'.'),20)`
    const binary = await script(root, 'tree', `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`)
    const run = processes.run({ label: 'Fake', executable: binary, args: [], cwd: root, signal: abort.signal, timeoutMs: 3000 })
    // Attach rejection immediately, then wait only for the fake's readiness evidence.
    const result = run.catch(error => error as Error)
    await vi.waitFor(async () => expect((await stat(beats)).size).toBeGreaterThan(0), { timeout: 1500, interval: 20 })
    abort.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    const size = (await stat(beats)).size
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await stat(beats)).size).toBe(size)
  })
})

const shQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
async function porchFixture(options: { response?: string; profile?: string; capabilities?: unknown; textExit?: number; runnerMarkers?: string } = {}) {
  const fixture = await agyFixture()
  const scripts = join(fixture.root, 'installation', 'scripts'), lib = join(scripts, 'lib'), log = join(fixture.root, 'porch.jsonl')
  const profile = options.profile ?? 'agy-gemini-3.8-flash', capabilities = join(fixture.root, 'capabilities.json')
  await writeFile(capabilities, JSON.stringify(options.capabilities ?? { transcribe: [profile], 'image.describe': ['claude-sonnet', profile] }))
  await mkdir(lib, { recursive: true })
  const handler = await script(fixture.root, 'porch-handler', `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),args=process.argv.slice(2),field=n=>args[args.indexOf(n)+1];
const prompt=args.includes('--prompt-file')?fs.readFileSync(field('--prompt-file'),'utf8'):undefined;
const schema=process.env.PORCH_OUTPUT_SCHEMA?JSON.parse(fs.readFileSync(process.env.PORCH_OUTPUT_SCHEMA,'utf8')):undefined;
const audioPath=path.join(process.cwd(),'audio.wav'),wav=fs.existsSync(audioPath)?fs.readFileSync(audioPath):undefined;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,prompt,schema,cwd:process.cwd(),audio:wav?{hash:crypto.createHash('sha256').update(wav).digest('hex'),header:Array.from(wav.subarray(0,44))}:undefined,env:{PATH:process.env.PATH,AGY_MODEL:process.env.AGY_MODEL,AGY_EFFORT:process.env.AGY_EFFORT,PORCH_BIN_AGY:process.env.PORCH_BIN_AGY,PORCH_SINGLE_AGENT:process.env.PORCH_SINGLE_AGENT,TMPDIR:process.env.TMPDIR,PORCH_RUN_DIR:process.env.PORCH_RUN_DIR,PORCH_DUMP_ARGV:process.env.PORCH_DUMP_ARGV,GEMINI_API_KEY:'GEMINI_API_KEY' in process.env,YOGURT_OPENROUTER_API_KEY:'YOGURT_OPENROUTER_API_KEY' in process.env,GOOGLE_API_KEY:'GOOGLE_API_KEY' in process.env,AGY_ADC_AUTH:'AGY_ADC_AUTH' in process.env,ANTHROPIC_API_KEY:'ANTHROPIC_API_KEY' in process.env,OPENAI_API_KEY:'OPENAI_API_KEY' in process.env,present:{PORCH_BIN_AGY:'PORCH_BIN_AGY' in process.env,AGY_MODEL:'AGY_MODEL' in process.env,AGY_EFFORT:'AGY_EFFORT' in process.env,CLAUDE_MODEL:'CLAUDE_MODEL' in process.env,CODEX_MODEL:'CODEX_MODEL' in process.env,PORCH_BIN_CODEX:'PORCH_BIN_CODEX' in process.env,PORCH_BIN_CLAUDE:'PORCH_BIN_CLAUDE' in process.env}}})+'\\n');
if(args[0]==='media' && args[1]==='capabilities' && args[2]==='--json') process.stdout.write(fs.readFileSync(${JSON.stringify(capabilities)},'utf8'));
else if(args[0]==='media') { console.error('public media must not transcode this WAV'); process.exit(9); }
else if(schema) process.stdout.write(${JSON.stringify(options.response ?? JSON.stringify(heard))});
${options.textExit === undefined ? `else process.stdout.write('## Итоги\\n- Всё готово.\\n');` : `else { process.stderr.write('fake porch text failure'); process.exit(${options.textExit}); }`}`)
  const source = `#!/usr/bin/env bash\n# ${options.runnerMarkers ?? '--raw|--no-wrap) MODE_CAP_SHELL build_cmd_agy PORCH_OUTPUT_SCHEMA PORCH_BIN_AGY'}\nexec ${shQuote(process.execPath)} ${shQuote(handler)} "$@"\n`
  const porch = join(scripts, 'porch')
  await writeFile(porch, source, { mode: 0o700 })
  await writeFile(join(lib, 'backend_run.sh'), source, { mode: 0o700 })
  const link = join(fixture.root, 'porch-link'); await symlink(porch, link)
  const settings: AiSettings = { ...fixture.settings, backend: 'porch', porchPath: link, textProfile: 'claude-sonnet', transcriptionProfile: profile }
  const harness = createSubscriptionHarness({ settings, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') }); stoppers.push(harness.stop)
  return { ...fixture, settings, harness, capabilities, porchCalls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}

describe('one exact Porch profile', () => {
  it.each(['*', 'codex,claude', 'codex?', '[abc]', '--help', '', 'codex claude'])('rejects fanout or option syntax %s', profile => expect(() => exactProfile(profile)).toThrow())
  it('accepts a literal configured profile', () => expect(exactProfile('agy-gemini-3.8-flash')).toBe('agy-gemini-3.8-flash'))
})

describe.skipIf(isWindows)('pinned Porch internal adapter', () => {
  it('resolves the real executable, uses raw media completion, and keeps profile model settings', async () => {
    vi.stubEnv('PORCH_DUMP_ARGV', 'must be removed')
    vi.stubEnv('AGY_MODEL', undefined); vi.stubEnv('AGY_EFFORT', undefined)
    const fixture = await porchFixture(), pieces: string[] = []
    const llm = await fixture.harness.model.llm()
    const answer = await llm.chat('Сделай заметки.', text => pieces.push(text))
    expect(answer).toBe('## Итоги\n- Всё готово.\n'); expect(pieces.join('')).toBe(answer)
    const [call] = await fixture.porchCalls()
    expect(call.args.slice(0, 5)).toEqual(['--mode', 'media', '--agent-id', 'claude-sonnet', '--raw'])
    expect(call.args).not.toContain('review'); expect(call.args).not.toContain('delegate')
    expect(call.env).not.toHaveProperty('AGY_MODEL'); expect(call.env).not.toHaveProperty('AGY_EFFORT')
    expect(call.env.PORCH_SINGLE_AGENT).toBe('1'); expect(call.env.PORCH_DUMP_ARGV).toBeUndefined()
    expect(call.env.TMPDIR).toBe(call.cwd); expect(call.env.PORCH_RUN_DIR).toBe(join(call.cwd, 'run'))
    expect(call.prompt).toContain('Сделай заметки.'); expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('strips provider API credentials from the text, probe, and audio child environments', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'never forward this')
    vi.stubEnv('YOGURT_OPENROUTER_API_KEY', 'fake-openrouter-key')
    vi.stubEnv('GOOGLE_API_KEY', 'never forward this either')
    vi.stubEnv('AGY_ADC_AUTH', 'true')
    vi.stubEnv('ANTHROPIC_API_KEY', 'never forward this')
    vi.stubEnv('OPENAI_API_KEY', 'never forward this either')
    const fixture = await porchFixture()
    await (await fixture.harness.model.llm()).chat('Сделай заметки.', () => {})
    await fixture.harness.transcriber(callbacks())(chunk())
    const calls = await fixture.porchCalls()
    expect(calls.map(call => call.args[0] === 'media' ? 'probe' : call.schema ? 'audio' : 'text')).toEqual(['text', 'probe', 'audio'])
    for (const call of calls) {
      expect(call.env).toMatchObject({ GEMINI_API_KEY: false, YOGURT_OPENROUTER_API_KEY: false, GOOGLE_API_KEY: false, AGY_ADC_AUTH: false, ANTHROPIC_API_KEY: false, OPENAI_API_KEY: false })
    }
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('passes the resolved agy path to the text route', async () => {
    const fixture = await porchFixture()
    await (await fixture.harness.model.llm()).chat('Сделай заметки.', () => {})
    const [call] = await fixture.porchCalls()
    expect(call.env.PORCH_BIN_AGY).toBe(await realpath(fixture.settings.agyPath))
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('prepends the resolved bash and agy directories to the Porch child PATH', async () => {
    const fixture = await porchFixture()
    await (await fixture.harness.model.llm()).chat('Сделай заметки.', () => {})
    const [call] = await fixture.porchCalls()
    const path = String(call.env.PATH).split(delimiter)
    expect(path.slice(0, 2)).toEqual([
      dirname(await executablePath('bash', 'Bash')),
      dirname(await realpath(fixture.settings.agyPath)),
    ])
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('clamps a low transcription effort to medium for the audio route', async () => {
    const fixture = await porchFixture()
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, transcriptionEffort: 'low' }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    await harness.transcriber(callbacks())(chunk())
    const audio = (await fixture.porchCalls()).find(call => call.schema)
    expect(audio.env.AGY_EFFORT).toBe('medium')
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('still runs the text route without PORCH_BIN_AGY when agy cannot be resolved', async () => {
    const fixture = await porchFixture()
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, agyPath: join(fixture.root, 'missing-agy') }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    await expect((await harness.model.llm()).chat('Сделай заметки.', () => {})).resolves.toBe('## Итоги\n- Всё готово.\n')
    const [call] = await fixture.porchCalls()
    expect(call.env).not.toHaveProperty('PORCH_BIN_AGY')
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('strips inherited Porch binary, model and effort overrides from the text child', async () => {
    vi.stubEnv('PORCH_BIN_AGY', '/foreign/agy')
    vi.stubEnv('AGY_MODEL', 'wrong'); vi.stubEnv('AGY_EFFORT', 'high'); vi.stubEnv('CLAUDE_MODEL', 'wrong')
    const fixture = await porchFixture()
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, agyPath: join(fixture.root, 'missing-agy') }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    await expect((await harness.model.llm()).chat('Сделай заметки.', () => {})).resolves.toBe('## Итоги\n- Всё готово.\n')
    const [call] = await fixture.porchCalls()
    expect(call.env.present).toMatchObject({ PORCH_BIN_AGY: false, AGY_MODEL: false, AGY_EFFORT: false, CLAUDE_MODEL: false })
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('reports the missing agy path instead of sign-in advice when an unresolved text run fails', async () => {
    const fixture = await porchFixture({ textExit: 4 })
    const missing = join(fixture.root, 'missing-agy')
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, agyPath: missing }, tempDir: fixture.tempDir, storeRoot: join(fixture.root, 'agy-store') })
    stoppers.push(harness.stop)
    const error = await (await harness.model.llm()).chat('Сделай заметки.', () => {}).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(missing)
    expect(String(error)).toContain('Finder')
    expect(String(error)).not.toContain('sign-in, model access, and quota')
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('rejects a runner source without the PORCH_BIN_AGY contract marker', async () => {
    const fixture = await porchFixture({ runnerMarkers: '--raw|--no-wrap) MODE_CAP_SHELL build_cmd_agy PORCH_OUTPUT_SCHEMA' })
    await expect(porchInstallation(fixture.settings.porchPath)).rejects.toThrow('internal raw adapter')
  })
  it('keeps the original two-second WAV, native schema and clock through one capable profile at medium effort', async () => {
    vi.stubEnv('AGY_MODEL', 'wrong inherited model'); vi.stubEnv('AGY_EFFORT', 'high')
    const fixture = await porchFixture({ profile: 'speech-account', response: JSON.stringify({ language: 'ru', segments: [{ start: 0, end: 2, text: 'Конец записи.' }] }) })
    const cb = callbacks(); cb.language = () => 'ru'; cb.prompt = () => 'Родион, Yogurt'
    const audio = chunk(); audio.samples.set([0, 0.25, -0.75, 1, -1])
    expect(await fixture.harness.transcriber(cb)(audio)).toEqual([{ track: 'them', startMs: 12_000, endMs: 14_000, text: 'Конец записи.' }])
    expect(cb.onLanguage).toHaveBeenCalledWith('them', 'russian', 'Конец записи.'.length, true)
    const [probe, call] = await fixture.porchCalls()
    expect(probe.args).toEqual(['media', 'capabilities', '--json'])
    expect(call.args.slice(0, 5)).toEqual(['--mode', 'media', '--agent-id', 'speech-account', '--raw'])
    expect(call.schema).toEqual(TRANSCRIPT_SCHEMA)
    expect(call.audio.hash).toBe(createHash('sha256').update(wavBytes(audio.samples)).digest('hex'))
    const header = Buffer.from(call.audio.header)
    expect(header.readUInt32LE(40) / header.readUInt32LE(28)).toBe(2)
    expect(call.prompt).toContain('view_file / read_file')
    expect(call.prompt).toContain('Expected spoken language: ru'); expect(call.prompt).toContain('Родион, Yogurt')
    expect(call.env.AGY_MODEL).toBe('gemini-3.8-flash'); expect(call.env.AGY_EFFORT).toBe('medium')
    expect(call.env.PORCH_BIN_AGY).toBe(await realpath(fixture.settings.agyPath))
    expect(call.env.PORCH_SINGLE_AGENT).toBe('1')
    await fixture.harness.transcriber(cb)(audio)
    expect((await fixture.porchCalls()).filter(call => call.args[0] === 'media')).toHaveLength(2)
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('gives the audio route at least 600 s while text keeps the configured timeout', async () => {
    const fixture = await porchFixture()
    const processes = new HarnessProcesses()
    stoppers.push(() => processes.stop())
    const run = vi.spyOn(processes, 'run').mockImplementation(async (options) => ({
      stdout: options.args.includes('capabilities') ? JSON.stringify({ transcribe: [fixture.settings.transcriptionProfile] }) : '{"segments":[]}',
      stderr: '', exitCode: 0,
    }))
    const dir = await directory()
    const porch = createPorch({ ...fixture.settings, timeoutSeconds: 180 }, processes)
    await porch.text('text request', dir)
    await porch.transcribe('audio request', dir)
    // text run, audio-capability probe (5 s), then the audio run
    expect(run.mock.calls.map(([options]) => options.timeoutMs)).toEqual([180_000, 5000, 600_000])
  })
  it('accepts only explicit JSON silence and rejects an empty backend answer', async () => {
    const silent = await porchFixture({ response: '{"segments":[]}' }), cb = callbacks()
    expect(await silent.harness.transcriber(cb)(chunk())).toEqual([])
    expect(cb.onLanguage).not.toHaveBeenCalled()
    const empty = await porchFixture({ response: '' })
    await expect(empty.harness.transcriber(callbacks())(chunk())).rejects.toThrow('empty response')
    expect(await readdir(empty.tempDir)).toEqual([])
  })
  it.each([
    '{"segments":[],"error":"PRIVATE AUDIO ERROR"}',
    '{"segments":[{"start":1,"end":0.5,"text":"PRIVATE AUDIO ERROR"}]}',
    '{"segments":[{"start":0,"end":4.088,"text":"PRIVATE AUDIO ERROR"}]}',
    '{"segments":[{"start":0,"end":1e999,"text":"PRIVATE AUDIO ERROR"}]}',
  ])('rejects repeated raw provider errors and clearly malformed timestamps without leaking provider text (%#)', async response => {
    const fixture = await porchFixture({ response }), cb = callbacks()
    const result = await fixture.harness.transcriber(cb)(chunk()).catch(error => error)
    expect(result).toBeInstanceOf(Error); expect(String(result)).not.toContain('PRIVATE AUDIO ERROR')
    expect(cb.onLanguage).not.toHaveBeenCalled(); expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('clamps a bounded timestamp overshoot without asking Porch for another response', async () => {
    const fixture = await porchFixture({ response: '{"segments":[{"start":-0.1,"end":1,"text":"anonymous phrase"}]}' })
    const lines = await fixture.harness.transcriber(callbacks())(chunk())
    expect(lines).toEqual([{ track: 'them', startMs: 12_000, endMs: 13_000, text: 'anonymous phrase' }])
    const calls = await fixture.porchCalls()
    expect(calls.filter(call => call.args[0] === '--mode')).toHaveLength(1)
    expect(calls.filter(call => call.args[0] === 'media' && call.args[1] === 'capabilities')).toHaveLength(1)
  })
  it('rejects an audio-looking profile absent from machine-readable audio capabilities, and retries after configuration is repaired', async () => {
    const fixture = await porchFixture({ capabilities: { transcribe: ['another-profile'], 'image.describe': ['agy-gemini-3.8-flash'] } })
    await expect(fixture.harness.transcriber(callbacks())(chunk())).rejects.toThrow('does not support native audio')
    expect(await fixture.porchCalls()).toHaveLength(1)
    await writeFile(fixture.capabilities, JSON.stringify({ transcribe: [fixture.settings.transcriptionProfile] }))
    await expect(fixture.harness.transcriber(callbacks())(chunk())).resolves.toHaveLength(1)
    expect(await fixture.porchCalls()).toHaveLength(3)
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('rejects malformed capabilities before starting a provider', async () => {
    const fixture = await porchFixture({ capabilities: { transcribe: 'agy-gemini-3.8-flash' } })
    await expect(fixture.harness.transcriber(callbacks())(chunk())).rejects.toThrow('valid audio profile capabilities')
    expect(await fixture.porchCalls()).toHaveLength(1)
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('checks installation without ffmpeg or ffprobe', async () => {
    const fixture = await porchFixture()
    vi.stubEnv('PORCH_BIN_FFMPEG', join(fixture.root, 'missing-ffmpeg'))
    vi.stubEnv('PORCH_BIN_FFPROBE', join(fixture.root, 'missing-ffprobe'))
    expect(await checkHarness(fixture.settings)).toMatchObject({ ok: true })
    expect(await fixture.calls()).toEqual([{ args: ['--version'] }])
  })
})
