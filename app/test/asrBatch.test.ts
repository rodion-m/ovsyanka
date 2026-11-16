import { describe, expect, it } from 'vitest'
import { packedToMeeting, takeBatch } from '../src/main/asr/batch'
import type { Chunk } from '../src/main/asr/chunker'

const chunk = (startMs: number, value: number, track: Chunk['track'] = 'them', sec = 1): Chunk => ({ track, startMs, samples: new Float32Array(Math.round(sec * 16_000)).fill(value), clearMs: 1000 })

describe('remote speech batching', () => {
  it('preserves nonzero meeting offsets and actual silence between queued phrases', () => {
    const queue = [chunk(50_000, 1), chunk(52_000, 2), chunk(54_000, 3)]
    const batch = takeBatch(queue, 45_000)!
    expect(queue).toHaveLength(0)
    expect(batch).toMatchObject({ track: 'them', startMs: 50_000, clearMs: 3000 })
    expect(batch.samples).toHaveLength(80_000)
    expect(batch.samples[0]).toBe(1)
    expect(batch.samples[24_000]).toBe(0)
    expect(batch.samples[32_000]).toBe(2)
    expect(batch.samples[64_000]).toBe(3)
  })

  it('packs speech and compresses pauses longer than a second to one second of zeros', () => {
    // meeting gaps of 300 ms, 4000 ms and 60 000 ms become 300, 1000 and 1000 ms of packed silence
    const queue = [
      chunk(10_000, 1, 'them', 1),   // [10000, 11000)
      chunk(11_300, 2, 'them', 2),   // gap 300
      chunk(17_300, 3, 'them', 1),   // gap 4000 (part 2 ends at 13300)
      chunk(78_300, 4, 'them', 1),   // gap 60000 (part 3 ends at 18300)
    ]
    const batch = takeBatch(queue, 300_000)!
    expect(queue).toHaveLength(0)
    // packed offsets: 0, 16000+4800=20800, 20800+32000+16000=68800, 68800+16000+16000=100800
    expect(batch.samples).toHaveLength(116_800)
    expect(batch.samples[0]).toBe(1)
    expect(batch.samples[15_999]).toBe(1)
    expect(batch.samples[20_799]).toBe(0)
    expect(batch.samples[20_800]).toBe(2)
    expect(batch.samples[52_799]).toBe(2)
    expect(batch.samples[68_799]).toBe(0)
    expect(batch.samples[68_800]).toBe(3)
    expect(batch.samples[84_799]).toBe(3)
    expect(batch.samples[99_999]).toBe(0)
    expect(batch.samples[100_800]).toBe(4)
    expect(batch.samples[116_799]).toBe(4)
    expect(batch.parts).toEqual([
      { atMs: 0, startMs: 10_000, durationMs: 1000 },
      { atMs: 1300, startMs: 11_300, durationMs: 2000 },
      { atMs: 4300, startMs: 17_300, durationMs: 1000 },
      { atMs: 6300, startMs: 78_300, durationMs: 1000 },
    ])
    expect(batch.clearMs).toBe(4000)
  })

  it('never throws and loses no sample when chunk times fall between samples', () => {
    const queue = [chunk(1000.03125, 1, 'them', 1), chunk(2999.96875, 2, 'them', 1)]
    const batch = takeBatch(queue, 300_000)!
    expect(queue).toHaveLength(0)
    // gap is 999.9375 ms = 15999 samples
    expect(batch.samples).toHaveLength(47_999)
    expect(batch.samples[0]).toBe(1)
    expect(batch.samples[15_999]).toBe(1)
    expect(batch.samples[31_998]).toBe(0)
    expect(batch.samples[31_999]).toBe(2)
    expect(batch.samples[47_998]).toBe(2)
    expect(batch.parts).toHaveLength(2)
  })

  it('never packs more audio than maxMs; a chunk that would exceed it stays queued', () => {
    const queue = [chunk(0, 1), chunk(2000, 2), chunk(4000, 3)]
    const batch = takeBatch(queue, 3500)!
    // packed: 16000 + 16000 (1 s gap) + 16000 = 48000 samples = 3000 ms; the third would reach 80000
    expect(batch.samples).toHaveLength(48_000)
    expect(batch.samples.length / 16).toBeLessThanOrEqual(3500)
    expect(queue).toHaveLength(1)
    expect(queue[0].startMs).toBe(4000)
    // the duration cap still applies on top of the packed length
    const capped = [chunk(0, 1), chunk(2000, 2), chunk(4000, 3)]
    expect(takeBatch(capped, 3000)?.samples).toHaveLength(48_000)
    expect(capped).toHaveLength(1)
  })

  it('ends the batch on a different track or a real overlap, but not on a long pause', () => {
    for (const next of [chunk(500, 2), chunk(2000, 2, 'me')]) {
      const queue = [chunk(0, 1), next]
      expect(takeBatch(queue, 45_000)?.samples).toHaveLength(16_000)
      expect(queue).toEqual([next])
    }
    const paused = [chunk(0, 1), chunk(60_000, 2)]
    const batch = takeBatch(paused, 45_000)!
    expect(paused).toHaveLength(0)
    expect(batch.samples).toHaveLength(48_000)
    expect(batch.parts).toHaveLength(2)
  })

  it('leaves the local single-chunk behavior unchanged', () => {
    const first = chunk(0, 1), next = chunk(2000, 2), queue = [first, next]
    expect(takeBatch(queue)).toBe(first)
    expect(queue).toEqual([next])
    expect(takeBatch([])).toBeUndefined()
  })
})

describe('packedToMeeting', () => {
  const parts = [
    { atMs: 0, startMs: 10_000, durationMs: 1000 },
    { atMs: 2000, startMs: 60_000, durationMs: 1000 },
    { atMs: 3500, startMs: 62_000, durationMs: 500 },
  ]
  it('maps linearly inside a part and snaps gap times to the neighbouring part', () => {
    expect(packedToMeeting(parts, 500, 'start', 0)).toBe(10_500)
    expect(packedToMeeting(parts, 500, 'end', 0)).toBe(10_500)
    expect(packedToMeeting(parts, 1500, 'end', 0)).toBe(11_000)
    expect(packedToMeeting(parts, 1500, 'start', 0)).toBe(60_000)
    expect(packedToMeeting(parts, 2000, 'start', 0)).toBe(60_000)
    expect(packedToMeeting(parts, 2100, 'end', 0)).toBe(60_100)
    expect(packedToMeeting(parts, 4000, 'end', 0)).toBe(62_500)
  })
  it('a chunk without a map is a single part on its own startMs', () => {
    expect(packedToMeeting(undefined, 1500, 'start', 12_000)).toBe(13_500)
    expect(packedToMeeting([], 250, 'end', 100)).toBe(350)
  })
})
