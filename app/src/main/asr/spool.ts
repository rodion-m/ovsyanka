import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Track } from '../capture'
import type { Spoken } from '../../shared/spoken'
import type { Chunk } from './chunker'

/**
 * Queued remote audio kept on disk until its lines are saved, inside the meeting's own folder
 * (`<meeting dir>/pending-audio/`), so deleting the meeting deletes its spool too. A quit or crash
 * between "transcribed" and "saved" loses nothing: the next launch (or the Retry button) sends it again.
 * The local Whisper path never touches it.
 */
export const SPOOL_DIR = 'pending-audio'

/** automatic recovery leaves a chunk alone after this many failed sends; the Retry button still sends it */
export const SPOOL_MAX_ATTEMPTS = 3

/** recovery sends at most this much audio of each track in one round, so a long spool is never all in memory */
export const SPOOL_ROUND_MS = 15 * 60_000

/** what recovery needs to know about a spooled chunk before its audio is read */
export type SpooledEntry = {
  key: string
  track: Track
  startMs: number
  clearMs?: number
  attempts: number
  blocked?: boolean
  /** length of the kept audio, ms */
  durationMs: number
  /** the spoken language the meeting had when this was queued */
  spoken?: Spoken
}
export type SpooledChunk = SpooledEntry & { samples: Float32Array }

/** what the pipeline needs of the spool: keep each queued chunk, drop the ones whose lines are saved */
export type ChunkSpool = {
  add(chunk: Chunk, spoken?: Spoken): string | undefined
  remove(keys: string[]): void
}

export type AudioSpool = ChunkSpool & {
  /** metadata only: is anything waiting, without reading a byte of audio */
  hasEntries(): boolean
  /** every whole entry's metadata, in meeting order; a sidecar whose sound is gone is logged once and removed */
  entries(): SpooledEntry[]
  /** the audio of the given entries, in the order given; entries whose sound is unreadable are dropped as corrupt */
  load(entries: readonly SpooledEntry[]): SpooledChunk[]
  list(): SpooledChunk[]
  /** counts one more failed send of this chunk (its sidecar is rewritten) */
  bump(key: string, attempts?: number): void
  block(key: string): void
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

/** split entries into rounds of at most maxMs of audio per track, keeping meeting order */
export function spoolRounds(entries: readonly SpooledEntry[], maxMs = SPOOL_ROUND_MS): SpooledEntry[][] {
  const rounds: SpooledEntry[][] = []
  let round: SpooledEntry[] = []
  const used = { me: 0, them: 0 }
  const flush = () => {
    if (round.length) rounds.push(round)
    round = []
    used.me = 0; used.them = 0
  }
  for (const e of entries) {
    if (round.length && used[e.track] + e.durationMs > maxMs) flush()
    round.push(e)
    used[e.track] += e.durationMs
  }
  flush()
  return rounds
}

export function createSpool(dir: string): AudioSpool {
  const fileOf = (key: string, ext: 'f32' | 'json') => join(dir, `${key}.${ext}`)
  const removeFiles = (key: string) => {
    for (const ext of ['f32', 'json'] as const) { try { rmSync(fileOf(key, ext), { force: true }) } catch { /* already gone */ } }
  }
  /** keys already reported as corrupt: logged once, removed on every sighting */
  const corruptSeen = new Set<string>()
  const corrupt = (key: string) => {
    if (!corruptSeen.has(key)) {
      corruptSeen.add(key)
      console.error('a spooled audio entry lost its sound file; dropping it', key)
    }
    removeFiles(key)
  }

  /** the sidecar's metadata, or undefined when it is not a readable entry; the sound file's size backs durationMs for older sidecars */
  const metaOf = (key: string): SpooledEntry | undefined => {
    let meta: { track?: unknown; startMs?: unknown; clearMs?: unknown; attempts?: unknown; durationMs?: unknown; spoken?: unknown; blocked?: unknown }
    try { meta = JSON.parse(readFileSync(fileOf(key, 'json'), 'utf8')) } catch { return undefined }
    if ((meta.track !== 'me' && meta.track !== 'them') || typeof meta.startMs !== 'number' || !Number.isFinite(meta.startMs)) return undefined
    let size: number
    try { size = statSync(fileOf(key, 'f32')).size } catch { return undefined }
    const durationMs = typeof meta.durationMs === 'number' && Number.isFinite(meta.durationMs) && meta.durationMs > 0
      ? meta.durationMs : size / 64 // 4 bytes a sample, 16 samples a ms
    return {
      key, track: meta.track, startMs: meta.startMs, durationMs,
      ...(typeof meta.clearMs === 'number' && Number.isFinite(meta.clearMs) ? { clearMs: meta.clearMs } : {}),
      attempts: typeof meta.attempts === 'number' && Number.isInteger(meta.attempts) && meta.attempts > 0 ? meta.attempts : 0,
      ...(meta.blocked === true ? { blocked: true } : {}),
      ...(meta.spoken === 'en' || meta.spoken === 'ru' || meta.spoken === 'multi' ? { spoken: meta.spoken } : {}),
    }
  }

  return {
    /** keeps one queued chunk; undefined when the disk refused (the chunk still transcribes, it just can't be recovered) */
    add(chunk: Chunk, spoken?: Spoken): string | undefined {
      try {
        mkdirSync(dir, { recursive: true })
        const base = `${chunk.track}-${Math.round(chunk.startMs)}`
        let key = base, n = 2
        while (existsSync(fileOf(key, 'f32')) || existsSync(fileOf(key, 'json'))) key = `${base}-${n++}`
        writeAtomic(fileOf(key, 'f32'), Buffer.from(chunk.samples.buffer, chunk.samples.byteOffset, chunk.samples.byteLength))
        writeAtomic(fileOf(key, 'json'), JSON.stringify({
          track: chunk.track, startMs: chunk.startMs,
          ...(chunk.clearMs !== undefined ? { clearMs: chunk.clearMs } : {}),
          durationMs: chunk.samples.length / 16,
          ...(spoken !== undefined ? { spoken } : {}),
          attempts: 0,
        }))
        return key
      } catch (e) {
        console.error('keeping queued audio failed', e)
        return undefined
      }
    },

    hasEntries(): boolean {
      try { return readdirSync(dir).some((f) => f.endsWith('.json') && KEY.test(f.slice(0, -'.json'.length))) } catch { return false }
    },

    /** every whole entry's metadata, in meeting order; a sidecar whose sound is gone is corrupt: logged once and removed */
    entries(): SpooledEntry[] {
      let names: string[]
      try { names = readdirSync(dir) } catch { return [] }
      const out: SpooledEntry[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const key = name.slice(0, -'.json'.length)
        if (!KEY.test(key)) continue
        const entry = metaOf(key)
        if (entry) out.push(entry)
        else corrupt(key)
      }
      return out.sort((a, b) => a.startMs - b.startMs || (a.track < b.track ? -1 : a.track > b.track ? 1 : 0))
    },

    load(entries: readonly SpooledEntry[]): SpooledChunk[] {
      const out: SpooledChunk[] = []
      for (const e of entries) {
        try {
          const buf = readFileSync(fileOf(e.key, 'f32'))
          if (buf.length % 4 !== 0) throw new Error('odd length')
          const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
          out.push({ ...e, samples })
        } catch { corrupt(e.key) }
      }
      return out
    },

    list(): SpooledChunk[] {
      return this.entries().flatMap((e) => this.load([e]))
    },

    bump(key: string, attempts = 1): void {
      try {
        const meta = JSON.parse(readFileSync(fileOf(key, 'json'), 'utf8')) as { attempts?: unknown }
        meta.attempts = (typeof meta.attempts === 'number' && Number.isInteger(meta.attempts) ? meta.attempts : 0) + attempts
        writeAtomic(fileOf(key, 'json'), JSON.stringify(meta))
      } catch (e) { console.error('counting a transcription retry failed', e) }
    },

    block(key: string): void {
      try {
        const meta = JSON.parse(readFileSync(fileOf(key, 'json'), 'utf8')) as { blocked?: unknown }
        meta.blocked = true
        writeAtomic(fileOf(key, 'json'), JSON.stringify(meta))
      } catch (e) { console.error('marking a transcription as blocked failed', e) }
    },

    remove(keys: string[]): void {
      for (const key of keys) if (KEY.test(key)) removeFiles(key)
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
