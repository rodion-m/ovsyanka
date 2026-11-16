import type { Chunk } from './chunker'

/**
 * Amortize remote CLI startup over speech that accumulated while the previous request was running.
 * Silence between chunks is retained so every timestamp remains on the recording's clock.
 * A pause/resume boundary or a different track must never be stitched together.
 */
export function takeBatch(queue: Chunk[], maxMs = 0): Chunk | undefined {
  const first = queue.shift()
  if (!first || maxMs <= 0) return first
  const parts = [first]
  let end = first.startMs + first.samples.length / 16
  while (queue.length) {
    const next = queue[0]
    const gap = next.startMs - end
    const nextEnd = next.startMs + next.samples.length / 16
    if (next.track !== first.track || gap < -1 / 16 || gap > 2000 || nextEnd - first.startMs > maxMs) break
    parts.push(queue.shift()!)
    end = nextEnd
  }
  if (parts.length === 1) return first
  const samples = new Float32Array(Math.round((end - first.startMs) * 16))
  for (const part of parts) samples.set(part.samples, Math.round((part.startMs - first.startMs) * 16))
  return {
    track: first.track, startMs: first.startMs, samples,
    ...(parts.every(p => p.clearMs !== undefined) ? { clearMs: parts.reduce((n, p) => n + p.clearMs!, 0) } : {}),
  }
}
