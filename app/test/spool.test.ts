import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSpool, meetingsWithSpool, SPOOL_DIR, spoolDirOf, spoolRounds, SPOOL_ROUND_MS, type SpooledEntry } from '../src/main/asr/spool'
import type { Chunk } from '../src/main/asr/chunker'

const dirs: string[] = []
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-spool-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const chunk = (track: 'me' | 'them', startMs: number, samples: Float32Array, clearMs?: number): Chunk =>
  ({ track, startMs, samples, ...(clearMs !== undefined ? { clearMs } : {}) })
const pcm = (n: number, fill = 0.25) => Float32Array.from({ length: n }, (_, i) => fill * Math.sin(i / 7))

describe('the pending-audio spool', () => {
  it('keeps a chunk and lists it back bit-exactly, with its track, time and clear length', () => {
    const d = dir(), spool = createSpool(d)
    const a = chunk('them', 12_345.4, pcm(1600), 900)
    const b = chunk('me', 0, pcm(800))
    const ka = spool.add(a)!, kb = spool.add(b)!
    expect(ka).not.toBe(kb)
    const all = spool.list()
    expect(all.map((e) => e.key)).toEqual([kb, ka]) // meeting order: the me chunk at 0, then them at 12345
    const ea = all.find((e) => e.key === ka)!, eb = all.find((e) => e.key === kb)!
    expect(ea.track).toBe('them'); expect(eb.track).toBe('me')
    expect(ea.startMs).toBe(12_345.4); expect(eb.startMs).toBe(0)
    expect(ea.clearMs).toBe(900); expect(eb.clearMs).toBeUndefined()
    expect([...ea.samples]).toEqual([...a.samples])
    expect([...eb.samples]).toEqual([...b.samples])
    expect(ea.attempts).toBe(0)
  })

  it('two chunks starting in the same millisecond get different keys', () => {
    const spool = createSpool(dir())
    const k1 = spool.add(chunk('them', 5000, pcm(1600)))!
    const k2 = spool.add(chunk('them', 5000, pcm(1600)))!
    expect(k1).not.toBe(k2)
    expect(spool.list()).toHaveLength(2)
  })

  it('remove drops exactly the given entries', () => {
    const spool = createSpool(dir())
    const k1 = spool.add(chunk('them', 0, pcm(1600)))!
    const k2 = spool.add(chunk('them', 5000, pcm(1600)))!
    const k3 = spool.add(chunk('me', 9000, pcm(1600)))!
    spool.remove([k2])
    expect(spool.list().map((e) => e.key).sort()).toEqual([k1, k3].sort())
    spool.remove([k1, k3, 'not-a-key'])
    expect(spool.list()).toEqual([])
  })

  it('bump counts sends, and a torn or half-written entry is ignored', () => {
    const d = dir(), spool = createSpool(d)
    const key = spool.add(chunk('them', 0, pcm(1600)))!
    spool.bump(key); spool.bump(key)
    expect(spool.list()[0].attempts).toBe(2)
    // a leftover temp file and a sidecar without its audio are both skipped
    writeFileSync(join(d, 'them-9999.f32.123.0.tmp'), 'half')
    writeFileSync(join(d, 'them-8888.json'), JSON.stringify({ track: 'them', startMs: 8888, attempts: 0 }))
    writeFileSync(join(d, 'junk.json'), '{not json')
    writeFileSync(join(d, 'me--5.json'), JSON.stringify({ track: 'me', startMs: -5, attempts: 0 }))
    writeFileSync(join(d, 'me--5.f32'), Buffer.alloc(8))
    const all = spool.list()
    expect(all.map((e) => e.key)).toEqual(['me--5', key]) // meeting order: -5 ms before 0
    expect(all.find((e) => e.key === 'me--5')!.samples).toHaveLength(2)
  })

  it('lists the meetings that still hold spooled audio', () => {
    const meetings = dir()
    const a = join(meetings, 'm-a'), b = join(meetings, 'm-b')
    createSpool(spoolDirOf(a)).add(chunk('them', 0, pcm(1600)))
    createSpool(spoolDirOf(b)) // made but empty
    expect(meetingsWithSpool(meetings)).toEqual(['m-a'])
    expect(SPOOL_DIR).toBe('pending-audio')
  })

  it('hasEntries is a metadata-only check: sidecars count, audio is never read', () => {
    const d = dir(), spool = createSpool(d)
    expect(spool.hasEntries()).toBe(false)
    const key = spool.add(chunk('them', 0, pcm(1600)))!
    expect(spool.hasEntries()).toBe(true)
    spool.remove([key])
    expect(spool.hasEntries()).toBe(false)
    // a corrupt sidecar still counts as something waiting until it is cleaned
    writeFileSync(join(d, 'them-9999.json'), JSON.stringify({ track: 'them', startMs: 9999, attempts: 0 }))
    expect(spool.hasEntries()).toBe(true)
    spool.entries()
    expect(spool.hasEntries()).toBe(false)
  })

  it('entries carry the audio length and the frozen spoken language from the sidecar', () => {
    const spool = createSpool(dir())
    spool.add(chunk('them', 0, pcm(1600)), 'ru')
    spool.add(chunk('me', 5000, pcm(800)))
    const all = spool.entries()
    expect(all).toHaveLength(2)
    const ru = all.find((e) => e.track === 'them')!
    expect(ru.spoken).toBe('ru')
    expect(ru.durationMs).toBeCloseTo(100) // 1600 samples at 16 per ms
    expect(all.find((e) => e.track === 'me')!.spoken).toBeUndefined()
    expect(all.find((e) => e.track === 'me')!.durationMs).toBeCloseTo(50)
  })

  it('a sidecar without its audio is corrupt: logged once and removed, not treated as drained', () => {
    const d = dir(), spool = createSpool(d)
    const key = spool.add(chunk('them', 0, pcm(1600)))!
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      writeFileSync(join(d, 'them-9999.json'), JSON.stringify({ track: 'them', startMs: 9999, attempts: 0 }))
      expect(spool.entries().map((e) => e.key)).toEqual([key])
      expect(existsSync(join(d, 'them-9999.json'))).toBe(false)
      expect(existsSync(join(d, 'them-9999.f32'))).toBe(false)
      expect(err.mock.calls.filter((c) => String(c[0]).includes('lost its sound file'))).toHaveLength(1)
      // seen again (recreated): removed silently, never logged twice
      writeFileSync(join(d, 'them-9999.json'), JSON.stringify({ track: 'them', startMs: 9999, attempts: 0 }))
      spool.entries()
      expect(existsSync(join(d, 'them-9999.json'))).toBe(false)
      expect(err.mock.calls.filter((c) => String(c[0]).includes('lost its sound file'))).toHaveLength(1)
    } finally { err.mockRestore() }
  })

  it('entries of older spools without durationMs fall back to the audio file size', () => {
    const d = dir(), spool = createSpool(d)
    const key = spool.add(chunk('them', 0, pcm(1600)))!
    // rewrite the sidecar the way the first spool version wrote it: no durationMs, no spoken
    writeFileSync(join(d, `${key}.json`), JSON.stringify({ track: 'them', startMs: 0, attempts: 0 }))
    const [e] = spool.entries()
    expect(e.durationMs).toBeCloseTo(100)
    expect(e.spoken).toBeUndefined()
  })
})

describe('spoolRounds', () => {
  const entry = (track: 'me' | 'them', startMs: number, durationMs: number): SpooledEntry =>
    ({ key: `${track}-${startMs}`, track, startMs, durationMs, attempts: 0 })

  it('caps each track at the round length, keeping meeting order', () => {
    const entries = [
      entry('them', 0, 60_000), entry('me', 1000, 60_000), entry('them', 120_000, 60_000),
      entry('them', 240_000, 60_000), entry('me', 300_000, 60_000),
    ]
    const rounds = spoolRounds(entries, 120_000)
    // them hits the cap after two minutes: the third them entry starts a new round
    expect(rounds.map((r) => r.map((e) => e.key))).toEqual([
      ['them-0', 'me-1000', 'them-120000'],
      ['them-240000', 'me-300000'],
    ])
  })

  it('a single chunk longer than the cap still gets a round of its own', () => {
    const rounds = spoolRounds([entry('them', 0, 999_000)], 100_000)
    expect(rounds).toHaveLength(1)
    expect(SPOOL_ROUND_MS).toBe(15 * 60_000)
  })
})
