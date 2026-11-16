import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_AI_SETTINGS, type AiSettings } from '../src/shared/ai'
import { agyAnswer } from '../src/main/harness/agy'
import { checkHarness, createSubscriptionHarness } from '../src/main/harness'
import { countTokens } from '../src/main/harness/model'
import { exactProfile } from '../src/main/harness/porch'
import { HarnessProcesses, inStage } from '../src/main/harness/process'
import { parseTranscript, TRANSCRIPT_SCHEMA } from '../src/main/harness/transcribe'
import { wavBytes } from '../src/main/asr/transcribe'
import { enhance, partBudget, splitForContext, summaryPrompt, type Llm } from '../src/main/notes/enhance'

const roots: string[] = []
const stoppers: Array<() => void> = []
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
    env: {GEMINI_API_KEY: 'GEMINI_API_KEY' in process.env, GOOGLE_API_KEY: 'GOOGLE_API_KEY' in process.env, AGY_ADC_AUTH: 'AGY_ADC_AUTH' in process.env}};
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + '\\n');
  const answers = ${JSON.stringify(response)};
  const messages = typeof answers === 'string' ? [] : JSON.parse(call.input.message.content.split('\\n\\n').find(part => part.startsWith('{"messages":'))).messages;
  const latest = messages.at(-1)?.content ?? '';
  const response = typeof answers === 'string' ? answers : latest.startsWith('Now give this meeting a title') ? answers.title
    : latest.startsWith('Now write only') ? answers.nextSteps : latest.includes('Write compact notes on this part only') ? answers.summary : answers.notes;
  console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'UNTRUSTED PARTIAL'}}));
  console.log(JSON.stringify({event:'step_update',step_update:{thinking_delta:'PRIVATE THOUGHT'}}));
  console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response,...${JSON.stringify(result)}}}));
});`)
  const settings: AiSettings = { ...DEFAULT_AI_SETTINGS, agyPath }
  const harness = createSubscriptionHarness({ settings, tempDir })
  stoppers.push(harness.stop)
  return { root, log, tempDir, settings, harness, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}
const callbacks = () => ({ prompt: () => '', language: () => undefined as string | undefined, onLanguage: vi.fn() })
const chunk = () => ({ track: 'them' as const, startMs: 12_000, samples: new Float32Array(32_000) })
const isWindows = process.platform === 'win32'

describe('agy final-answer contract', () => {
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
})

describe('transcript validation', () => {
  it('accepts real silence, and clamps only sub-millisecond duration rounding', () => {
    expect(parseTranscript('{"segments":[]}', 2)).toEqual({ segments: [] })
    expect(parseTranscript('{"segments":[{"start":0,"end":2.0005,"text":" Да. "}]}', 2).segments).toEqual([{ start: 0, end: 2, text: 'Да.' }])
  })
  it.each([
    '{"segments":[{"start":-0.1,"end":1,"text":"secret"}]}',
    '{"segments":[{"start":1,"end":0.5,"text":"secret"}]}',
    '{"segments":[{"start":0,"end":3,"text":"secret"}]}',
    '{"segments":[{"start":0,"end":1e999,"text":"secret"}]}',
    '{"segments":[{"start":"0","end":1,"text":"secret"}]}',
    '{"segments":[],"error":"secret"}', '{"segments":false}', 'secret',
  ])('rejects invalid transcription data without leaking it (%#)', output => {
    expect(() => parseTranscript(output, 2)).toThrow()
    try { parseTranscript(output, 2) } catch (error) { expect(String(error)).not.toContain('secret') }
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
    expect(call.env).toEqual({ GEMINI_API_KEY: false, GOOGLE_API_KEY: false, AGY_ADC_AUTH: false })
    const audio = Buffer.from(call.audio)
    expect(audio.toString('ascii', 0, 4)).toBe('RIFF'); expect(audio.readUInt32LE(24)).toBe(16_000); expect(audio.readUInt32LE(40)).toBe(64_000)
    expect(call.schema.required).toEqual(['segments'])
    expect(call.input.message.content).toContain('view_file / read_file')
    expect(call.input.message.content).toContain('Expected spoken language: ru')
    expect(call.input.message.content).toContain('Родион, Yogurt')
    expect(call.cwd).not.toBe(process.cwd()); expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('does not make remote requests or even create staging files for partial chunks', async () => {
    const fixture = await agyFixture()
    expect(await fixture.harness.transcriber(callbacks())(chunk(), { partial: true })).toEqual([])
    await expect(stat(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(fixture.tempDir)).rejects.toMatchObject({ code: 'ENOENT' })
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
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, outputLanguage: 'ru' }, tempDir: fixture.tempDir })
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
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, outputLanguage: 'ru' }, tempDir: fixture.tempDir })
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
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, contextTokens: 8192 }, tempDir: fixture.tempDir })
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
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, contextTokens, outputLanguage: 'ru' }, tempDir: fixture.tempDir })
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
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, agyPath: missing }, tempDir: fixture.tempDir })
    stoppers.push(harness.stop)
    const llm = await harness.model.llm()
    await expect(llm.chat('Проверка', () => {})).rejects.toThrow('was not found')
    await symlink(fixture.settings.agyPath, missing)
    await expect(llm.chat('Проверка', () => {})).resolves.toBe('Установлено.')
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('aborts an active model request without final callbacks and removes its prompt stage', async () => {
    const fixture = await agyFixture(), abort = new AbortController(), ready = join(fixture.root, 'active')
    const binary = await script(fixture.root, 'waiting-agy', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'1');process.stdin.resume();setInterval(()=>{},1000)`)
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, agyPath: binary }, tempDir: fixture.tempDir })
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

describe.skipIf(isWindows)('bounded process lifecycle', () => {
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
async function porchFixture(options: { response?: string; profile?: string; capabilities?: unknown } = {}) {
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
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,prompt,schema,cwd:process.cwd(),audio:wav?{hash:crypto.createHash('sha256').update(wav).digest('hex'),header:Array.from(wav.subarray(0,44))}:undefined,env:{AGY_MODEL:process.env.AGY_MODEL,AGY_EFFORT:process.env.AGY_EFFORT,PORCH_BIN_AGY:process.env.PORCH_BIN_AGY,PORCH_SINGLE_AGENT:process.env.PORCH_SINGLE_AGENT,TMPDIR:process.env.TMPDIR,PORCH_RUN_DIR:process.env.PORCH_RUN_DIR,PORCH_DUMP_ARGV:process.env.PORCH_DUMP_ARGV,GEMINI_API_KEY:'GEMINI_API_KEY' in process.env,GOOGLE_API_KEY:'GOOGLE_API_KEY' in process.env,AGY_ADC_AUTH:'AGY_ADC_AUTH' in process.env}})+'\\n');
if(args[0]==='media' && args[1]==='capabilities' && args[2]==='--json') process.stdout.write(fs.readFileSync(${JSON.stringify(capabilities)},'utf8'));
else if(args[0]==='media') { console.error('public media must not transcode this WAV'); process.exit(9); }
else if(schema) process.stdout.write(${JSON.stringify(options.response ?? JSON.stringify(heard))});
else process.stdout.write('## Итоги\\n- Всё готово.\\n');`)
  const source = `#!/usr/bin/env bash\n# --raw|--no-wrap) MODE_CAP_SHELL build_cmd_agy PORCH_OUTPUT_SCHEMA\nexec ${shQuote(process.execPath)} ${shQuote(handler)} "$@"\n`
  const porch = join(scripts, 'porch')
  await writeFile(porch, source, { mode: 0o700 })
  await writeFile(join(lib, 'backend_run.sh'), source, { mode: 0o700 })
  const link = join(fixture.root, 'porch-link'); await symlink(porch, link)
  const settings: AiSettings = { ...fixture.settings, backend: 'porch', porchPath: link, textProfile: 'claude-sonnet', transcriptionProfile: profile }
  const harness = createSubscriptionHarness({ settings, tempDir: fixture.tempDir }); stoppers.push(harness.stop)
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
  it('never forwards API-key variables to any Porch child, for text or audio', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'never forward this')
    vi.stubEnv('GOOGLE_API_KEY', 'never forward this either')
    vi.stubEnv('AGY_ADC_AUTH', 'true')
    const fixture = await porchFixture()
    await (await fixture.harness.model.llm()).chat('Сделай заметки.', () => {})
    await fixture.harness.transcriber(callbacks())(chunk())
    const calls = await fixture.porchCalls()
    expect(calls.map(call => call.args[0] === 'media' ? 'probe' : call.schema ? 'audio' : 'text')).toEqual(['text', 'probe', 'audio'])
    for (const call of calls) {
      expect(call.env).toMatchObject({ GEMINI_API_KEY: false, GOOGLE_API_KEY: false, AGY_ADC_AUTH: false })
    }
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('passes the resolved agy path to the text route so a Finder launch can find it', async () => {
    const fixture = await porchFixture()
    await (await fixture.harness.model.llm()).chat('Сделай заметки.', () => {})
    const [call] = await fixture.porchCalls()
    expect(call.env.PORCH_BIN_AGY).toBe(fixture.settings.agyPath)
    expect(await readdir(fixture.tempDir)).toEqual([])
  })
  it('still runs the text route without PORCH_BIN_AGY when agy cannot be resolved', async () => {
    const fixture = await porchFixture()
    const harness = createSubscriptionHarness({ settings: { ...fixture.settings, agyPath: join(fixture.root, 'missing-agy') }, tempDir: fixture.tempDir })
    stoppers.push(harness.stop)
    await expect((await harness.model.llm()).chat('Сделай заметки.', () => {})).resolves.toBe('## Итоги\n- Всё готово.\n')
    const [call] = await fixture.porchCalls()
    expect(call.env).not.toHaveProperty('PORCH_BIN_AGY')
    expect(await readdir(fixture.tempDir)).toEqual([])
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
    expect(call.env.PORCH_BIN_AGY).toBe(fixture.settings.agyPath)
    expect(call.env.PORCH_SINGLE_AGENT).toBe('1')
    await fixture.harness.transcriber(cb)(audio)
    expect((await fixture.porchCalls()).filter(call => call.args[0] === 'media')).toHaveLength(1)
    expect(await readdir(fixture.tempDir)).toEqual([])
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
    '{"segments":[{"start":-0.1,"end":1,"text":"PRIVATE AUDIO ERROR"}]}',
    '{"segments":[{"start":1,"end":0.5,"text":"PRIVATE AUDIO ERROR"}]}',
    '{"segments":[{"start":0,"end":2.088,"text":"PRIVATE AUDIO ERROR"}]}',
    '{"segments":[{"start":0,"end":1e999,"text":"PRIVATE AUDIO ERROR"}]}',
  ])('rejects raw provider errors and malformed timestamps without public Porch clamping (%#)', async response => {
    const fixture = await porchFixture({ response }), cb = callbacks()
    const result = await fixture.harness.transcriber(cb)(chunk()).catch(error => error)
    expect(result).toBeInstanceOf(Error); expect(String(result)).not.toContain('PRIVATE AUDIO ERROR')
    expect(cb.onLanguage).not.toHaveBeenCalled(); expect(await readdir(fixture.tempDir)).toEqual([])
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
