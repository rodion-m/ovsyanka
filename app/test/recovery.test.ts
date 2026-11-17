import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hookTranscription, pendingRecovery, recoverTranscription, resumeTranscriptWaitMs, settleTranscription, stopTranscriptionServer, transcriptFinished, transcriptIncomplete, transcribing } from '../src/main/asr'
import { createSpool, spoolDirOf, SPOOL_MAX_ATTEMPTS } from '../src/main/asr/spool'
import { openStore, type Meeting, type Store } from '../src/main/store'
import type { Line } from '../src/main/asr/transcribe'
import type { Chunk } from '../src/main/asr/chunker'
import type { Spoken } from '../src/shared/spoken'
import type { EchoCheck } from '../src/main/asr/echo'

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
function rig(t: {
  say?: (c: Chunk) => Promise<Line[]> | Line[]
  /** the banner state may have flipped for a meeting */
  changed?: (id: string) => void
  /** the meeting is being resumed right now */
  resuming?: (id: string) => boolean
  /** saved echoes changed: the window reads them again */
  refresh?: (id: string) => void
  /** the spoken language setting */
  spoken?: () => Spoken
  /** for tests: stand in for the echo detector */
  echoForTests?: EchoCheck
  /** a language the fake transcriber reports it heard (chars, locked) */
  heardLang?: string
  /** collects the language callbacks the transcriber was built with */
  languages?: Array<() => string | undefined>
  /** who the call app showed talking, for lines of the other side */
  nameOf?: string | null
} = {}) {
  const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
  const sent: string[] = [], warns: string[] = []
  const calls: Chunk[] = []
  disposers.push(hookTranscription({
    store, modelPath: () => { throw new Error('Must not load Whisper') }, send: (s) => sent.push(`${s.track}:${s.text}`), warn: (c) => warns.push(c),
    holdMs: 20, quickReads: false, batchMs: 60_000,
    meetingDir: (id) => join(meetingsDir, id),
    ...(t.changed ? { changed: t.changed } : {}),
    ...(t.resuming ? { resuming: t.resuming } : {}),
    ...(t.refresh ? { refresh: t.refresh } : {}),
    ...(t.spoken ? { spoken: t.spoken } : {}),
    ...(t.echoForTests ? { echoForTests: t.echoForTests } : {}),
    ...(t.nameOf !== undefined ? { nameOf: () => t.nameOf ?? null } : {}),
    transcriberFactory: (o) => {
      t.languages?.push(o.language)
      return async (c) => {
        calls.push(c)
        if (t.heardLang) o.onLanguage(c.track, t.heardLang, 100, true)
        return t.say ? t.say(c) : (c.parts ?? [{ startMs: c.startMs, durationMs: c.samples.length / 16 }]).map((p) => ({ track: c.track, startMs: p.startMs, endMs: p.startMs + 1000, text: `${c.track} recovered at ${p.startMs}` }))
      }
    },
    onStart: (fn) => { starts.push(fn); return () => {} }, onStop: (fn) => { stops.push(fn); return () => {} }, pidFile: undefined,
  }))
  return { starts, stops, sent, warns, calls, begin: (m: Meeting) => starts.forEach((f) => f(m)) }
}

/** the local Whisper path: no batching, no spool */
function rigLocal() {
  const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
  disposers.push(hookTranscription({
    store, modelPath: () => undefined, send: () => {}, warn: () => {},
    transcriber: async () => [],
    onStart: (fn) => { starts.push(fn); return () => {} }, onStop: (fn) => { stops.push(fn); return () => {} }, pidFile: undefined,
  }))
  return { starts, stops, begin: (m: Meeting) => starts.forEach((f) => f(m)) }
}

/** audio left on disk by a quit or crash, as the pipeline's spool wrote it */
function spoolAudio(id: string, entries: Array<{ track: 'me' | 'them'; startMs: number; sec?: number; clearMs?: number; spoken?: Spoken }>) {
  const spool = createSpool(spoolDirOf(join(meetingsDir, id)))
  return entries.map((e) => spool.add({ track: e.track, startMs: e.startMs, samples: pcm(e.sec ?? 1), ...(e.clearMs !== undefined ? { clearMs: e.clearMs } : {}) }, e.spoken)!)
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

  it('a failing transcriber keeps the spool and counts one failed send per chunk', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ say: () => { throw new Error('provider down') } })
      const m = meeting()
      store.updateMeeting(m.id, { transcriptionPending: true })
      spoolAudio(m.id, [{ track: 'them', startMs: 0 }, { track: 'them', startMs: 2000 }])
      const done = recoverTranscription(m.id)
      await vi.advanceTimersByTimeAsync(10_000) // the batch's one in-session retry waits 5 s
      await done
      const left = spooled(m.id)
      expect(left).toHaveLength(2)
      // two sends (first + in-pipeline retry) failed for good: one attempt counted per chunk, not per send
      expect(left.map((e) => e.attempts)).toEqual([1, 1])
      expect(store.meeting(m.id)?.transcriptionPending).toBe(true)
      expect(r.calls.length).toBeGreaterThan(0)
    } finally { vi.useRealTimers() }
  })

  it('an aborted send counts no attempt', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ say: () => { const e = new Error('AI request cancelled'); e.name = 'AbortError'; throw e } })
      const m = meeting()
      store.updateMeeting(m.id, { transcriptionPending: true })
      spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
      const done = recoverTranscription(m.id)
      await vi.advanceTimersByTimeAsync(10_000)
      await done
      const left = spooled(m.id)
      expect(left).toHaveLength(1)
      expect(left[0].attempts).toBe(0)
      expect(r.calls.length).toBe(1) // an abort is never retried in-session
    } finally { vi.useRealTimers() }
  })

  it('chunks that never went out keep their attempts', async () => {
    // no transcriber at all: the session has no pipeline, so nothing is sent
    const starts: Array<(m: Meeting) => void> = []
    disposers.push(hookTranscription({
      store, modelPath: () => undefined, send: () => {}, warn: () => {},
      batchMs: 60_000, meetingDir: (id) => join(meetingsDir, id),
      onStart: (fn) => { starts.push(fn); return () => {} }, pidFile: undefined,
    }))
    const m = meeting()
    store.updateMeeting(m.id, { transcriptionPending: true })
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    await recoverTranscription(m.id)
    const left = spooled(m.id)
    expect(left).toHaveLength(1)
    expect(left[0].attempts).toBe(0)
    expect(store.meeting(m.id)?.transcriptionPending).toBe(true)
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

  it('skips a meeting that is only marked as recording, and one being resumed', async () => {
    const r = rig()
    const live = meeting('recording')
    spoolAudio(live.id, [{ track: 'them', startMs: 0 }])
    await recoverTranscription(live.id)
    expect(r.calls).toEqual([])
    expect(spooled(live.id)).toHaveLength(1)

    const resuming = meeting()
    spoolAudio(resuming.id, [{ track: 'them', startMs: 0 }])
    disposers.push(hookTranscription({
      store, modelPath: () => { throw new Error('Must not load Whisper') }, send: () => {}, warn: () => {},
      holdMs: 20, quickReads: false, batchMs: 60_000,
      meetingDir: (id) => join(meetingsDir, id), resuming: (id) => id === resuming.id,
      transcriberFactory: () => async () => [],
      onStart: () => () => {}, onStop: () => () => {}, pidFile: undefined,
    }))
    await recoverTranscription(resuming.id)
    expect(spooled(resuming.id)).toHaveLength(1)
  })

  it('keeps one in-flight recovery per meeting', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const r = rig({ say: async (c) => { await gate; return (c.parts ?? [{ startMs: c.startMs, durationMs: 1 }]).map((p) => ({ track: c.track, startMs: p.startMs, endMs: p.startMs + 1, text: 'late' })) } })
    const m = meeting()
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    const first = recoverTranscription(m.id)
    expect(pendingRecovery(m.id)).toBe(first)
    // a second call joins the in-flight one instead of opening another session
    expect(recoverTranscription(m.id)).toBe(first)
    release()
    await first
    expect(spooled(m.id)).toEqual([])
    expect(pendingRecovery(m.id)).toBeInstanceOf(Promise)
  })

  it('open() never hands out a session whose drain already began', async () => {
    const changes: string[] = []
    const r = rig({ changed: (id) => changes.push(id) })
    const m = meeting('recording')
    r.begin(m)
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    r.stops.forEach((f) => f(m)) // the session's drain begins: done is set, cleanup pending
    changes.length = 0
    r.begin(m) // must open a fresh session, not return the closing one
    // only a fresh session reports the still-waiting spool
    expect(changes).toEqual([m.id])
    await settleTranscription(2000)
  })
})

describe('the incomplete-transcript banner state', () => {
  it('is true with spooled audio and no session, false while one runs or drains, and reported on flips', async () => {
    const changes: string[] = []
    const r = rig({ changed: (id) => changes.push(id) })
    const m = meeting()
    store.updateMeeting(m.id, { transcriptionPending: true })
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    expect(transcriptIncomplete(m.id)).toBe(true)
    const done = recoverTranscription(m.id)
    // a session now covers the waiting audio: off while it works
    expect(transcriptIncomplete(m.id)).toBe(false)
    await done
    // drained: still off, and the flip was reported
    expect(transcriptIncomplete(m.id)).toBe(false)
    expect(changes).toContain(m.id)
    expect(r.calls.length).toBeGreaterThan(0)
  })

  it('stays false while a stopped meeting\'s transcript is still draining', async () => {
    const m = meeting('recording')
    const r2 = rig()
    r2.begin(m)
    r2.stops.forEach((f) => f(m))
    // audio a crash left behind, still on disk while the drain runs
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    expect(transcriptIncomplete(m.id)).toBe(false)
    await settleTranscription(2000)
    // the drain ended with the entry never sent: now it really is waiting
    expect(transcriptIncomplete(m.id)).toBe(true)
  })

  it('is never true on the local Whisper path, even with a spool folder on disk', async () => {
    rigLocal()
    const m = meeting()
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    expect(transcriptIncomplete(m.id)).toBe(false)
  })

  it('is true again when recovery ends with audio still waiting, and the flip is reported', async () => {
    const changes: string[] = []
    rig({ changed: (id) => changes.push(id), say: () => { throw new Error('down') } })
    vi.useFakeTimers()
    try {
      const m = meeting()
      store.updateMeeting(m.id, { transcriptionPending: true })
      spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
      const done = recoverTranscription(m.id)
      await vi.advanceTimersByTimeAsync(10_000)
      await done
      expect(transcriptIncomplete(m.id)).toBe(true)
      // hid when the session opened, back when it drained with the batch still unsent
      expect(changes.filter((id) => id === m.id).length).toBeGreaterThanOrEqual(2)
    } finally { vi.useRealTimers() }
  })
})

describe('recovery rounds and language', () => {
  it('a spool longer than 15 minutes of audio per track drains in more than one round', async () => {
    const updateMeeting = vi.spyOn(store, 'updateMeeting')
    const r = rig()
    const m = meeting()
    store.updateMeeting(m.id, { transcriptionPending: true })
    updateMeeting.mockClear()
    // 16 sidecar entries claiming a minute each on one track, with tiny real audio: over the round cap
    const dir = spoolDirOf(join(meetingsDir, m.id))
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 16; i++) {
      writeFileSync(join(dir, `them-${i * 60_000}.f32`), Buffer.alloc(64))
      writeFileSync(join(dir, `them-${i * 60_000}.json`), JSON.stringify({ track: 'them', startMs: i * 60_000, durationMs: 60_000, attempts: 0 }))
    }
    await recoverTranscription(m.id)
    // every open() marks the meeting pending: one per round
    const sessionsOpened = updateMeeting.mock.calls.filter(([, u]) => (u as { transcriptionPending?: boolean }).transcriptionPending === true).length
    expect(sessionsOpened).toBe(2)
    expect(store.segments(m.id).length).toBeGreaterThan(0)
    expect(spooled(m.id)).toEqual([])
    expect(store.meeting(m.id)?.transcriptionPending).not.toBe(true)
    expect(r.calls.length).toBeGreaterThan(0)
  })

  it('transcribes recovered audio with the spoken language kept in the sidecar', async () => {
    const languages: Array<() => string | undefined> = []
    rig({ languages })
    const m = meeting()
    spoolAudio(m.id, [{ track: 'them', startMs: 0, spoken: 'ru' }])
    await recoverTranscription(m.id)
    expect(languages.length).toBeGreaterThan(0)
    expect(languages[0]!()).toBe('ru')
  })

  it('recovered lines get no call-participant names', async () => {
    rig({ nameOf: 'Caller' })
    const m = meeting()
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }])
    await recoverTranscription(m.id)
    const them = store.segments(m.id).filter((s) => s.track === 'them')
    expect(them.length).toBeGreaterThan(0)
    expect(them.every((s) => s.speaker == null)).toBe(true)
  })

  it('a recovery session fills in the meeting language only when it had none', async () => {
    rig({ heardLang: 'russian' })
    const kept = meeting()
    store.updateMeeting(kept.id, { language: 'english' })
    spoolAudio(kept.id, [{ track: 'them', startMs: 0 }])
    await recoverTranscription(kept.id)
    expect(store.meeting(kept.id)?.language).toBe('english')

    const empty = meeting()
    spoolAudio(empty.id, [{ track: 'them', startMs: 0 }])
    await recoverTranscription(empty.id)
    expect(store.meeting(empty.id)?.language).toBe('russian')
  })

  it('a throwing refresh does not keep a saved batch in the spool', async () => {
    const refresh = vi.fn(() => { throw new Error('renderer gone') })
    const same = 'the quick brown fox jumps over the lazy dog today'
    rig({
      refresh,
      echoForTests: { echo: true, correlatedAt: () => true },
      say: (c) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: same }],
    })
    const m = meeting()
    spoolAudio(m.id, [{ track: 'them', startMs: 0 }, { track: 'me', startMs: 0 }])
    await recoverTranscription(m.id)
    // the me copy of their line was saved hidden; the refresh throwing changed nothing
    expect(store.segments(m.id, { hidden: true }).some((s) => s.hidden)).toBe(true)
    expect(refresh).toHaveBeenCalled()
    expect(spooled(m.id)).toEqual([])
  })
})

describe('the resume wait for a draining transcript', () => {
  it('is four minutes on the remote path and thirty seconds locally', () => {
    expect(resumeTranscriptWaitMs(true)).toBe(4 * 60_000)
    expect(resumeTranscriptWaitMs(false)).toBe(30_000)
  })
})

describe('transcriptFinished', () => {
  it('resolves at once with no session and waits for a draining one', async () => {
    const m = meeting()
    await transcriptFinished(m.id)
    const r = rig()
    const live = meeting('recording')
    r.begin(live)
    r.stops.forEach((f) => f(live))
    await transcriptFinished(live.id)
    expect(transcribing()).toBe(false)
  })
})
