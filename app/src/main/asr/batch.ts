import type { Chunk } from './chunker'

/** Pauses between queued chunks longer than this are sent as this much silence, so speech packs densely. */
export const MAX_GAP_MS = 1000

/**
 * Amortize remote CLI startup over speech that accumulated while the previous request was running.
 * Queued chunks of one track are packed in order; a pause longer than MAX_GAP_MS becomes exactly
 * that much silence, shorter ones keep their real length, and every chunk's `parts` entry maps its
 * packed offset back to the meeting clock. A pause/resume boundary (overlap) or a different track
 * must never be stitched together. maxMs caps the packed audio length, not the meeting span.
 */
export function takeBatch(queue: Chunk[], maxMs = 0): Chunk | undefined {
  const first = queue.shift()
  if (!first || maxMs <= 0) return first
  const parts = [first]
  const offsets = [0]
  let end = first.startMs + first.samples.length / 16
  let packed = first.samples.length
  while (queue.length) {
    const next = queue[0]
    const gap = next.startMs - end
    const nextEnd = next.startMs + next.samples.length / 16
    if (next.track !== first.track || gap < -1 / 16) break
    const offset = offsets[offsets.length - 1] + parts[parts.length - 1].samples.length
      + Math.min(Math.max(Math.round(gap * 16), 0), MAX_GAP_MS * 16)
    // the cap is on packed samples: fractional startMs can make a ms-derived length lie
    if (offset + next.samples.length > maxMs * 16) break
    parts.push(queue.shift()!)
    offsets.push(offset)
    packed = offset + next.samples.length
    end = nextEnd
  }
  if (parts.length === 1) return first
  const samples = new Float32Array(packed)
  parts.forEach((part, i) => samples.set(part.samples, offsets[i]))
  return {
    track: first.track, startMs: first.startMs, samples,
    parts: parts.map((part, i) => ({ atMs: offsets[i] / 16, startMs: part.startMs, durationMs: part.samples.length / 16 })),
    ...(parts.every(p => p.clearMs !== undefined) ? { clearMs: parts.reduce((n, p) => n + p.clearMs!, 0) } : {}),
  }
}

/**
 * A time inside a packed batch, in ms of packed audio, on the meeting clock. Inside a part the map
 * is linear; inside the zeros between parts (kept or compressed pauses) an end snaps to the
 * previous part's end and a start to the next part's start. No map: the chunk is one part.
 */
export function packedToMeeting(parts: Chunk['parts'], atMs: number, edge: 'start' | 'end', startMs: number): number {
  if (!parts?.length) return startMs + atMs
  let prevEnd = startMs
  for (const part of parts) {
    const partEnd = part.atMs + part.durationMs
    if (atMs < partEnd) {
      if (atMs >= part.atMs) return part.startMs + (atMs - part.atMs)
      return edge === 'end' ? prevEnd : part.startMs
    }
    prevEnd = part.startMs + part.durationMs
  }
  return prevEnd
}
