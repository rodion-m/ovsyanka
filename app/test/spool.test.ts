import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSpool, meetingsWithSpool, SPOOL_DIR, spoolDirOf } from '../src/main/asr/spool'
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
})
