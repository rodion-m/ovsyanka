import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Track } from '../capture'
import type { Chunk } from './chunker'

/**
 * Queued remote audio kept on disk until its lines are saved, inside the meeting's own folder
 * (`<meeting dir>/pending-audio/`), so deleting the meeting deletes its spool too. A quit or crash
 * between "transcribed" and "saved" loses nothing: the next launch (or the Retry button) sends it again.
 * The local Whisper path never touches it.
 */
export const SPOOL_DIR = 'pending-audio'

/** automatic recovery leaves a chunk alone after this many sends; the Retry button still sends it */
export const SPOOL_MAX_ATTEMPTS = 3

/** one queued chunk kept on disk; attempts counts the recovery sends it already had */
export type SpooledChunk = {
  key: string
  track: Track
  startMs: number
  clearMs?: number
  attempts: number
  samples: Float32Array
}

/** what the pipeline needs of the spool: keep each queued chunk, drop the ones whose lines are saved */
export type ChunkSpool = {
  add(chunk: Chunk): string | undefined
  remove(keys: string[]): void
}

export type AudioSpool = ChunkSpool & {
  list(): SpooledChunk[]
  /** counts one more send of this chunk (its sidecar is rewritten before it goes out) */
  bump(key: string): void
}

export const spoolDirOf = (meetingDir: string): string => join(meetingDir, SPOOL_DIR)

/** a spool key is `<track>-<startMs>` plus a `-n` suffix when the same second was queued twice */
const KEY = /^(?:me|them)-?-?\d+(?:-\d+)*$/

let tmpN = 0
/** temp file + rename: a reader never sees half of either file, and a torn temp is ignored on list */
const writeAtomic = (path: string, data: string | Buffer) => {
  const tmp = `${path}.${process.pid}.${tmpN++}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

export function createSpool(dir: string): AudioSpool {
  const fileOf = (key: string, ext: 'f32' | 'json') => join(dir, `${key}.${ext}`)

  return {
    /** keeps one queued chunk; undefined when the disk refused (the chunk still transcribes, it just can't be recovered) */
    add(chunk: Chunk): string | undefined {
      try {
        mkdirSync(dir, { recursive: true })
        const base = `${chunk.track}-${Math.round(chunk.startMs)}`
        let key = base, n = 2
        while (existsSync(fileOf(key, 'f32')) || existsSync(fileOf(key, 'json'))) key = `${base}-${n++}`
        writeAtomic(fileOf(key, 'f32'), Buffer.from(chunk.samples.buffer, chunk.samples.byteOffset, chunk.samples.byteLength))
        writeAtomic(fileOf(key, 'json'), JSON.stringify({ track: chunk.track, startMs: chunk.startMs, ...(chunk.clearMs !== undefined ? { clearMs: chunk.clearMs } : {}), attempts: 0 }))
        return key
      } catch (e) {
        console.error('keeping queued audio failed', e)
        return undefined
      }
    },

    /** every whole entry on disk, in meeting order; a torn or half-written one is skipped */
    list(): SpooledChunk[] {
      let names: string[]
      try { names = readdirSync(dir) } catch { return [] }
      const out: SpooledChunk[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const key = name.slice(0, -'.json'.length)
        if (!KEY.test(key)) continue
        try {
          const meta = JSON.parse(readFileSync(fileOf(key, 'json'), 'utf8')) as { track?: unknown; startMs?: unknown; clearMs?: unknown; attempts?: unknown }
          if ((meta.track !== 'me' && meta.track !== 'them') || typeof meta.startMs !== 'number' || !Number.isFinite(meta.startMs)) continue
          const buf = readFileSync(fileOf(key, 'f32'))
          if (buf.length % 4 !== 0) continue
          const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
          out.push({
            key, track: meta.track, startMs: meta.startMs, samples,
            ...(typeof meta.clearMs === 'number' && Number.isFinite(meta.clearMs) ? { clearMs: meta.clearMs } : {}),
            attempts: typeof meta.attempts === 'number' && Number.isInteger(meta.attempts) && meta.attempts > 0 ? meta.attempts : 0,
          })
        } catch { /* torn or unreadable: ignored */ }
      }
      return out.sort((a, b) => a.startMs - b.startMs || (a.track < b.track ? -1 : a.track > b.track ? 1 : 0))
    },

    bump(key: string): void {
      try {
        const meta = JSON.parse(readFileSync(fileOf(key, 'json'), 'utf8')) as { attempts?: unknown }
        meta.attempts = (typeof meta.attempts === 'number' && Number.isInteger(meta.attempts) ? meta.attempts : 0) + 1
        writeAtomic(fileOf(key, 'json'), JSON.stringify(meta))
      } catch (e) { console.error('counting a transcription retry failed', e) }
    },

    remove(keys: string[]): void {
      for (const key of keys) {
        if (!KEY.test(key)) continue
        for (const ext of ['f32', 'json'] as const) { try { rmSync(fileOf(key, ext), { force: true }) } catch { /* already gone */ } }
      }
    },
  }
}

/** the meetings whose folder still holds audio waiting for transcription */
export function meetingsWithSpool(meetingsDir: string): string[] {
  let dirs
  try { dirs = readdirSync(meetingsDir, { withFileTypes: true }) } catch { return [] }
  return dirs.filter((d) => {
    if (!d.isDirectory()) return false
    try { return readdirSync(join(meetingsDir, d.name, SPOOL_DIR)).some((f) => f.endsWith('.json') && KEY.test(f.slice(0, -'.json'.length))) } catch { return false }
  }).map((d) => d.name)
}
