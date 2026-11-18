import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { aiSettings } from '../src/shared/ai'
import { probeOpenRouter } from '../src/main/harness/openrouterTest'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'yogurt-stt-probe-'))
  roots.push(path)
  return path
}

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('OpenRouter STT model probe', () => {
  it('refuses a response without segments and caches/reuses a successful timestamp probe', async () => {
    const userData = await root()
    const cacheFile = join(userData, 'openrouter-models.json')
    await writeFile(cacheFile, JSON.stringify({ schema: 1, fetchedAt: Date.now(), text: [{}], stt: [{}], probes: {} }))
    const options = {
      settings: aiSettings({ backend: 'openrouter', openrouterTranscriptionKind: 'stt', openrouterTranscriptionModel: 'acme/stt' }),
      task: 'transcription' as const,
      key: { read: async () => 'fake-key' },
      userData,
      usage: { record: async () => {} },
      audioFixture: join(process.cwd(), 'resources/openrouter-test.wav'),
    }
    const failed = await probeOpenRouter({ ...options, fetch: async () => answer({ text: 'No timing available.' }) })
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain('no timestamped segments')

    let calls = 0
    const fetch = async () => { calls++; return answer({ language: 'ru', segments: [{ start: 0, end: 4.5, text: 'Проверка.' }], usage: { seconds: 5, cost: 0.001 } }) }
    expect((await probeOpenRouter({ ...options, fetch })).ok).toBe(true)
    expect(calls).toBe(1)
    const saved = JSON.parse(await readFile(cacheFile, 'utf8')) as { probes: Record<string, unknown> }
    expect(saved.probes['acme/stt']).toMatchObject({ timestamps: true })
    expect((await probeOpenRouter({ ...options, fetch })).ok).toBe(true)
    expect(calls).toBe(1)
  })
})
