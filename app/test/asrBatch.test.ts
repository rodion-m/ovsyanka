import { describe, expect, it } from 'vitest'
import { takeBatch } from '../src/main/asr/batch'
import type { Chunk } from '../src/main/asr/chunker'

const chunk = (startMs: number, value: number, track: Chunk['track'] = 'them'): Chunk => ({ track, startMs, samples: new Float32Array(16_000).fill(value), clearMs: 1000 })

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

  it('respects duration, pause boundaries, overlaps and track ownership', () => {
    const capped = [chunk(0, 1), chunk(2000, 2), chunk(4000, 3)]
    expect(takeBatch(capped, 3000)?.samples).toHaveLength(48_000)
    expect(capped).toHaveLength(1)
    for (const next of [chunk(20_000, 2), chunk(500, 2), chunk(2000, 2, 'me')]) {
      const queue = [chunk(0, 1), next]
      expect(takeBatch(queue, 45_000)?.samples).toHaveLength(16_000)
      expect(queue).toEqual([next])
    }
  })

  it('leaves the local single-chunk behavior unchanged', () => {
    const first = chunk(0, 1), next = chunk(2000, 2), queue = [first, next]
    expect(takeBatch(queue)).toBe(first)
    expect(queue).toEqual([next])
    expect(takeBatch([])).toBeUndefined()
  })
})
