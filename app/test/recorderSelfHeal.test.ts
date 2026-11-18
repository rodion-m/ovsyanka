import { describe, expect, it } from 'vitest'
import { shouldRebuildSystem, shouldResetBackoff } from '../src/main/recorderSelfHeal'

describe('native recorder self-heal mirror', () => {
  it('rebuilds only after 60 audio seconds with output, when due, under the cap', () => {
    expect(shouldRebuildSystem({ zeroMs: 59_999, outputProcesses: 1, rebuilds: 0, backoffDue: true })).toBe(false)
    expect(shouldRebuildSystem({ zeroMs: 60_000, outputProcesses: 0, rebuilds: 0, backoffDue: true })).toBe(false)
    expect(shouldRebuildSystem({ zeroMs: 60_000, outputProcesses: 1, rebuilds: 5, backoffDue: true })).toBe(false)
    expect(shouldRebuildSystem({ zeroMs: 60_000, outputProcesses: 1, rebuilds: 4, backoffDue: false })).toBe(false)
    expect(shouldRebuildSystem({ zeroMs: 60_000, outputProcesses: 1, rebuilds: 4, backoffDue: true })).toBe(true)
  })
  it('resets rebuild backoff only after ten sustained seconds of sound', () => {
    expect(shouldResetBackoff(9_999)).toBe(false)
    expect(shouldResetBackoff(10_000)).toBe(true)
  })
})
