import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiProbeResult, AiSettings } from '../../shared/ai'
import { parseTranscript } from './transcribe'
import { createOpenRouter } from './openrouter'
import type { OpenRouterKeyStore } from './openrouterKey'
import type { OpenRouterUsage } from './openrouterUsage'
import type { OpenRouterKeyFetch } from './openrouterKey'
import { OPENROUTER_MODELS_CACHE_FILE } from './openrouterModels'

const PROBE_TTL = 7 * 24 * 60 * 60 * 1_000
const PROBE_SECONDS = 5

function wavDataChunk(wav: Buffer): { sizeOffset: number; dataOffset: number; size: number } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('The transcription probe audio is not a WAV file.')
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4)
    if (wav.toString('ascii', offset, offset + 4) === 'data' && offset + 8 + size <= wav.length) return { sizeOffset: offset + 4, dataOffset: offset + 8, size }
    offset += 8 + size + (size % 2)
  }
  throw new Error('The transcription probe audio has no PCM data chunk.')
}

function padProbeWav(source: Buffer): Buffer {
  const chunk = wavDataChunk(source)
  const targetBytes = PROBE_SECONDS * 32_000
  if (chunk.size >= targetBytes) return source
  const insertAt = chunk.dataOffset + chunk.size
  const padded = Buffer.concat([source.subarray(0, insertAt), Buffer.alloc(targetBytes - chunk.size), source.subarray(insertAt)])
  padded.writeUInt32LE(targetBytes, chunk.sizeOffset)
  padded.writeUInt32LE(padded.length - 8, 4)
  return padded
}

async function cachedSttProbe(file: string, model: string, now: number): Promise<boolean> {
  try {
    const cache = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (cache.schema !== 1 || !Array.isArray(cache.text) || !Array.isArray(cache.stt)) return false
    const probes = cache.probes as Record<string, { timestamps?: unknown; at?: unknown }> | undefined
    const probe = probes?.[model]
    return probe?.timestamps === true && typeof probe.at === 'number' && probe.at <= now && now - probe.at < PROBE_TTL
  } catch { return false }
}

async function rememberSttProbe(file: string, model: string, at: number): Promise<void> {
  try {
    const cache = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (cache.schema !== 1 || !Array.isArray(cache.text) || !Array.isArray(cache.stt)) return
    const probes = cache.probes && typeof cache.probes === 'object' && !Array.isArray(cache.probes) ? cache.probes as Record<string, unknown> : {}
    const temporary = `${file}.${process.pid}.${randomUUID()}.probe.tmp`
    await writeFile(temporary, JSON.stringify({ ...cache, probes: { ...probes, [model]: { timestamps: true, at } } }), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  } catch { /* an absent or unreadable model cache cannot store an optional probe result */ }
}

/** One bounded, user-requested model probe. The audio fixture is copied to an isolated staging directory. */
export async function probeOpenRouter(o: {
  settings: AiSettings
  task: 'text' | 'transcription'
  key: Pick<OpenRouterKeyStore, 'read'> & Partial<Pick<OpenRouterKeyStore, 'markRejected'>>
  fetch: OpenRouterKeyFetch
  userData: string
  usage: Pick<OpenRouterUsage, 'record'>
  audioFixture: string
  baseUrl?: string
}): Promise<AiProbeResult> {
  const startedAt = Date.now()
  let costUsd: number | undefined
  let responseText = ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let stage: string | undefined
  try {
    const cacheFile = join(o.userData, OPENROUTER_MODELS_CACHE_FILE)
    if (o.task === 'transcription' && o.settings.openrouterTranscriptionKind === 'stt' && await cachedSttProbe(cacheFile, o.settings.openrouterTranscriptionModel, Date.now())) {
      return { ok: true, elapsedMs: 0, message: 'Cached STT timestamp probe passed.' }
    }
    const adapter = createOpenRouter({
      settings: o.settings, key: o.key, fetch: o.fetch, userData: o.userData, usage: o.usage,
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      log: event => { if (event.costUsd !== undefined) costUsd = event.costUsd },
    })
    if (o.task === 'text') {
      responseText = await adapter.text('Reply with exactly: OK', controller.signal, 32)
      if (!/\bOK\b/i.test(responseText)) throw new Error('The model did not return OK.')
    } else {
      stage = await mkdtemp(join(tmpdir(), 'yogurt-openrouter-probe-'))
      const wav = padProbeWav(await readFile(o.audioFixture))
      await writeFile(join(stage, 'audio.wav'), wav, { mode: 0o600 })
      const duration = PROBE_SECONDS
      const output = await adapter.transcribe({ directory: stage, language: 'ru', instructions: 'Короткая проверочная запись.', prompt: '', signal: controller.signal })
      const transcript = parseTranscript(output, duration)
      if (o.settings.openrouterTranscriptionKind === 'stt') {
        if (!transcript.segments.length) throw new Error('The STT model returned no timestamped segments.')
        await rememberSttProbe(join(o.userData, OPENROUTER_MODELS_CACHE_FILE), o.settings.openrouterTranscriptionModel, Date.now())
      }
      responseText = transcript.segments.map(segment => segment.text).join(' ')
    }
    return { ok: true, elapsedMs: Date.now() - startedAt, ...(responseText ? { message: responseText.slice(0, 240) } : {}), ...(costUsd === undefined ? {} : { costUsd }) }
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - startedAt, message: error instanceof Error ? error.message : 'OpenRouter test failed.', ...(costUsd === undefined ? {} : { costUsd }) }
  } finally {
    clearTimeout(timer)
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
}
