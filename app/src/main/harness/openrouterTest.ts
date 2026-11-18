import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiProbeResult, AiSettings } from '../../shared/ai'
import { parseTranscript } from './transcribe'
import { createOpenRouter } from './openrouter'
import type { OpenRouterKeyStore } from './openrouterKey'
import type { OpenRouterUsage } from './openrouterUsage'
import type { OpenRouterKeyFetch } from './openrouterKey'

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
      await copyFile(o.audioFixture, join(stage, 'audio.wav'))
      const wav = await readFile(join(stage, 'audio.wav'))
      const dataBytes = wav.readUInt32LE(40)
      const duration = Math.max(0.1, dataBytes / 32_000)
      const output = await adapter.transcribe({ directory: stage, language: 'ru', instructions: 'Короткая проверочная запись.', prompt: '', signal: controller.signal })
      const transcript = parseTranscript(output, duration)
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
