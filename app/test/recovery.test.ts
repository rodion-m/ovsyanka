import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hookTranscription, recoverTranscription, resumeTranscriptWaitMs, settleTranscription, stopTranscriptionServer } from '../src/main/asr'
import { createSpool, spoolDirOf, SPOOL_MAX_ATTEMPTS } from '../src/main/asr/spool'
import { openStore, type Meeting, type Store } from '../src/main/store'
import type { Line } from '../src/main/asr/transcribe'
import type { Chunk } from '../src/main/asr/chunker'

const RATE = 16000
const pcm = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.3 * Math.sin(i / 10))

let store: Store, meetingsDir: string
beforeEach(() => { store = openStore(':memory:'); meetingsDir = mkdtempSync(join(tmpdir(), 'yogurt-recovery-')) })
afterEach(() => { rmSync(meetingsDir, { recursive: true, force: true }) })

const disposers: Array<() => void> = []
afterEach(async () => { disposers.splice(0).forEach((d) => d()); await settleTranscription(2000); stopTranscriptionServer() })

const meeting = (state: Meeting['state'] = 'stopped'): Meeting =>
  store.createMeeting({ title: 't', startedAt: 1, endedAt: state === 'stopped' ? 2 : null, eventId: null, app: null, attendees: [], state })

/** the remote (harness) path: batched transcription, each meeting's audio spooled in its own folder */
function rig(t: { say?: (c: Chunk) => Promise<Line[]> | Line[] } = {}) {
  const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
  const sent: string[] = [], warns: string[] = []
  const calls: Chunk[] = []
  disposers.push(hookTranscription({
    store, modelPath: () => { throw new Error('Must not load Whisper') }, send: (s) => sent.push(`${s.track}:${s.text}`), warn: (c) => warns.push(c),
    holdMs: 20, quickReads: false, batchMs: 60_000,
    meetingDir: (id) => join(meetingsDir, id),
    transcriberFactory: () => async (c) => { calls.push(c); return t.say ? t.say(c) : (c.parts ?? [{ startMs: c.startMs, durationMs: c.samples.length / 16 }]).map((p) => ({ track: c.track, startMs: p.startMs, endMs: p.startMs + 1000, text: `${c.track} recovered at ${p.startMs}` })) },
    onStart: (fn) => { starts.push(fn); return () => {} }, onStop: (fn) => { stops.push(fn); return () => {} }, pidFile: undefined,
  }))
  return { starts, stops, sent, warns, calls, begin: (m: Meeting) => starts.forEach((f) => f(m)) }
}

/** audio left on disk by a quit or crash, as the pipeline's spool wrote it */
function spoolAudio(id: string, entries: Array<{ track: 'me' | 'them'; startMs: number; sec?: number; clearMs?: number }>) {
  const spool = createSpool(spoolDirOf(join(meetingsDir, id)))
  return entries.map((e) => spool.add({ track: e.track, startMs: e.startMs, samples: pcm(e.sec ?? 1), ...(e.clearMs !== undefined ? { clearMs: e.clearMs } : {}) })!)
}
const spooled = (id: string) => createSpool(spoolDirOf(join(meetingsDir, id))).list()

describe('recovering a pending remote transcript', () => {
  it('sends the spooled chunks again, saves their lines on the meeting clock, and clears the pending mark', async () => {
    const r = rig()
    const m = meeting()
    store.updateMeeting(m.id, { transcriptionPending: true })
    spoolAudio(m.id, [{ track: 'them', startMs: 5_000, clearMs: 800 }, { track: 'me', startMs: 60_000 }])
    await recoverTranscription(m.id)
    // the them chunk's clear length survived the spool
    expect(r.calls.some((c) => c.clearMs === 800)).toBe(true)
    const segs = store.segments(m.id)
    expect(segs.map((s) => [s.track, s.startMs]).sort()).toEqual([['me', 60_000], ['them', 5_000]])
    expect(spooled(m.id)).toEqual([])
    expect(store.meeting(m.id)?.transcriptionPending).not.toBe(true)
  })

  it('a meeting pending with an empty spool is no longer pending', async () => {
    rig()
    const m = meeting()
    store.updateMeeting(m.id, { transcriptionPending: true })
    await recoverTranscription(m.id)
    expect(store.meeting(m.id)?.transcriptionPending).not.toBe(true)
  })

  it('a failing transcriber keeps the spool and counts the send', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ say: () => { throw new Error('provider down') } })
      const m = meeting()
      store.updateMeeting(m.id, { transcriptionPending: true })
      spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
      const done = recoverTranscription(m.id)
      await vi.advanceTimersByTimeAsync(10_000) // the batch's one in-session retry waits 5 s
      await done
      const left = spooled(m.id)
      expect(left).toHaveLength(1)
      expect(left[0].attempts).toBe(1)
      expect(store.meeting(m.id)?.transcriptionPending).toBe(true)
      expect(r.calls.length).toBeGreaterThan(0)
    } finally { vi.useRealTimers() }
  })

  it('chunks that failed enough automatic sends wait for the Retry button', async () => {
    const r = rig()
    const m = meeting()
    store.updateMeeting(m.id, { transcriptionPending: true })
    const [key] = spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    const spool = createSpool(spoolDirOf(join(meetingsDir, m.id)))
    for (let i = 0; i < SPOOL_MAX_ATTEMPTS; i++) spool.bump(key)
    await recoverTranscription(m.id)
    expect(r.calls).toEqual([])
    expect(spooled(m.id)).toHaveLength(1)
    expect(store.meeting(m.id)?.transcriptionPending).toBe(true)
    // the Retry button sends them anyway
    await recoverTranscription(m.id, { retry: true })
    expect(r.calls.length).toBeGreaterThan(0)
    expect(spooled(m.id)).toEqual([])
    expect(store.meeting(m.id)?.transcriptionPending).not.toBe(true)
  })

  it('never runs beside a live session of the same meeting', async () => {
    const r = rig()
    const m = meeting('recording')
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    r.begin(m) // the live session opens first
    await recoverTranscription(m.id)
    expect(r.calls).toEqual([])
    expect(spooled(m.id)).toHaveLength(1)
    r.stops.forEach((f) => f(m))
    await settleTranscription(2000)
  })
})

describe('the resume wait for a draining transcript', () => {
  it('is four minutes on the remote path and thirty seconds locally', () => {
    expect(resumeTranscriptWaitMs(true)).toBe(4 * 60_000)
    expect(resumeTranscriptWaitMs(false)).toBe(30_000)
  })
})
