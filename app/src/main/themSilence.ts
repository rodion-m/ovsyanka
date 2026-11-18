import type { Meeting } from './store'
import type { ThemSilentPhase } from '../shared/types'

/**
 * The silent-"them" watchdog: while a call is on and the computer's sound comes through as
 * (near) exact zeros, the other side can't be heard. It first asks the recorder to rebuild
 * its system tap by itself; only when that didn't help does it warn — in the widget, in the
 * note, and once per meeting in the system notification. Everything it records is meeting
 * times (positions in the recording), never audio.
 *
 * Evidence rules keep webinars and solo talks quiet: a lone participant never warns; once
 * the call reader has seen anyone talk, only its "someone else is talking" counts; the mic
 * level is the fallback only for calls whose reader never reports speakers.
 */

/** them at or under this level (the level is dB-mapped 0..1; this is about -60 dBFS) counts as silent */
export const THEM_SILENT_FLOOR = 1e-4
/** how long "them" must stay silent with someone talking before the first rebuild */
export const THEM_SILENT_MS = 60_000
/** how long after a rebuild "them" gets to come back before the warning shows */
export const THEM_RECHECK_MS = 30_000
/** the mic level that counts as the person talking (same 0..1 scale) */
export const THEM_MIC_LEVEL = 0.15
/** speech this long before a silent stretch still counts as "someone was talking" */
const EVIDENCE_LEAD_MS = 60_000
/** a stretch shorter than this is not worth keeping */
const RANGE_MIN_MS = 1_000
/** the success line stays this long */
const OK_MS = 4_000

export type ThemWatch = { participants: number | null; sawSpeakers: boolean; otherTalkedAt: number | null } | null

export type ThemView = { phase: ThemSilentPhase | null; muted: boolean }

type Session = {
  id: string
  /** recording position = basePos + (wall - baseWall) - paused time before wall */
  baseWall: number
  basePos: number
  pauses: Array<[number, number]>
  pausedAt: number | null
  /** pos where the current them-silent streak began (warning conditions held) */
  silentPos: number | null
  /** pos where the current candidate silent range began */
  stretchStart: number | null
  stretchHadEvidence: boolean
  lastMicWall: number | null
  /** 'idle' → first rebuild sent; 'auto1' → waiting out the recheck; 'warned' → alert shown, no more auto rebuilds */
  stage: 'idle' | 'auto1' | 'warned'
  rebuiltPos: number | null
  manualPos: number | null
  phase: ThemSilentPhase | null
  okUntilPos: number | null
  ranges: Array<[number, number]>
}

export function createThemSilence(d: {
  now?: () => number
  /** Settings → "Warn when the other side can't be heard" (on by default) */
  warnEnabled(): boolean
  /** the call watcher: a call app is on right now */
  callOn(): boolean
  /** the call reader's view of this meeting; null when it reads nothing */
  watch(id: string): ThemWatch
  /** rebuild-system to the running capture; false when none runs */
  rebuild(id: string): boolean
  /** one system notification per meeting; index.ts owns the actual Notification */
  notify(id: string): void
  /** the widget/note state changed; index.ts pushes it */
  publish(id: string): void
  /** ranges saved so far for this meeting (resume keeps them) */
  loadRanges(id: string): Array<[number, number]>
  saveRanges(id: string, ranges: Array<[number, number]>): void
  log?(msg: string): void
}) {
  const now = d.now ?? Date.now
  const sessions = new Map<string, Session>()
  /** "don't warn for this meeting" and the one notification: kept for the meeting's whole run, resume included */
  const muted = new Set<string>()
  const notified = new Set<string>()

  const log = (msg: string) => d.log?.(msg)

  const pausedBefore = (s: Session, wall: number): number => {
    let total = 0
    for (const [a, b] of s.pauses) {
      if (wall <= a) break
      total += Math.min(wall, b) - a
    }
    if (s.pausedAt != null && wall > s.pausedAt) total += wall - s.pausedAt
    return total
  }
  const posAt = (s: Session, wall: number) => s.basePos + (wall - s.baseWall) - pausedBefore(s, wall)

  const pushPhase = (s: Session, phase: ThemSilentPhase | null) => {
    if (s.phase === phase) return
    s.phase = phase
    d.publish(s.id)
  }

  const closeStretch = (s: Session, endPos: number) => {
    const start = s.stretchStart
    const had = s.stretchHadEvidence
    s.stretchStart = null
    s.stretchHadEvidence = false
    if (start == null || !had || endPos - start < RANGE_MIN_MS) return
    const ranges = [...s.ranges, [start, endPos] as [number, number]]
      .sort((a, b) => a[0] - b[0])
      .reduce<Array<[number, number]>>((out, r) => {
        const last = out[out.length - 1]
        if (last && r[0] <= last[1] + 500) last[1] = Math.max(last[1], r[1])
        else out.push([...r] as [number, number])
        return out
      }, [])
    s.ranges = ranges
    d.saveRanges(s.id, ranges)
  }

  /** one 10 Hz level frame for the meeting being recorded */
  const level = (meetingId: string, me: number, them: number) => {
    const s = sessions.get(meetingId)
    if (!s || s.pausedAt != null) return
    const at = now()
    const pos = posAt(s, at)
    const w = d.watch(meetingId)
    // alone in the call: nothing to warn about, and silence is expected
    const conds = d.callOn() && w?.participants !== 1
    if (me > THEM_MIC_LEVEL) s.lastMicWall = at
    // the reader once it saw speakers talk is the only evidence; before that the mic speaks for a silent reader
    const evWall = w?.sawSpeakers ? w.otherTalkedAt : s.lastMicWall
    const evPos = evWall != null ? posAt(s, evWall) : null

    const silent = them <= THEM_SILENT_FLOOR

    // the honest record: silent stretches while call conditions held, kept even when warnings are off or muted
    if (silent && conds) {
      if (s.stretchStart == null) {
        s.stretchStart = pos
        s.stretchHadEvidence = evPos != null && evPos >= pos - EVIDENCE_LEAD_MS
      } else if (evPos != null && evPos >= s.stretchStart - EVIDENCE_LEAD_MS) {
        s.stretchHadEvidence = true
      }
    } else {
      closeStretch(s, pos)
    }

    // sound is back: whatever the warning said, it is over (and the watchdog re-arms)
    if (!silent) {
      s.silentPos = null
      s.stage = 'idle'
      s.rebuiltPos = null
      s.manualPos = null
      if (s.phase === 'warn' || s.phase === 'restarting' || s.phase === 'failed') {
        s.okUntilPos = pos + OK_MS
        pushPhase(s, 'ok')
      } else if (s.phase === 'ok' && s.okUntilPos != null && pos >= s.okUntilPos) {
        pushPhase(s, null)
      }
      return
    }

    // from here "them" is silent this tick
    if (s.phase === 'ok') {
      if (s.okUntilPos != null && pos >= s.okUntilPos) pushPhase(s, null)
      return
    }
    if (!conds) {
      s.silentPos = null
      if (s.phase === 'warn' || s.phase === 'restarting' || s.phase === 'failed') pushPhase(s, null)
      return
    }

    if (s.silentPos == null) s.silentPos = pos
    const streak = pos - s.silentPos
    const evidence = evPos != null && evPos >= s.silentPos - EVIDENCE_LEAD_MS
    // muted for this meeting or warned off in Settings: detection keeps its place, but nothing is
    // sent, shown or announced — and the recorder's own healing is untouched either way
    const appOn = d.warnEnabled() && !muted.has(s.id)
    if (!appOn) {
      if (s.phase === 'warn' || s.phase === 'restarting' || s.phase === 'failed' || s.phase === 'ok') pushPhase(s, null)
      return
    }
    // back from "don't warn": the alert returns while its conditions still hold
    if (s.stage === 'warned' && s.phase == null) pushPhase(s, 'warn')

    if (s.stage === 'idle' && streak >= THEM_SILENT_MS && evidence) {
      // first try is silent: ask the recorder to rebuild its tap and give it a moment
      s.stage = 'auto1'
      s.rebuiltPos = pos
      log(`them silent ${Math.round(streak / 1000)} s with someone talking: rebuild-system`)
      d.rebuild(s.id)
    } else if (s.stage === 'auto1' && s.rebuiltPos != null && pos - s.rebuiltPos >= THEM_RECHECK_MS) {
      // the rebuild didn't help: warn, and try once more by ourselves — then the person decides
      s.stage = 'warned'
      s.rebuiltPos = null
      log('them still silent 30 s after rebuild-system: warning and one more rebuild')
      d.rebuild(s.id)
      pushPhase(s, 'warn')
      if (!notified.has(s.id)) { notified.add(s.id); d.notify(s.id) }
    } else if (s.phase === 'restarting' && s.manualPos != null && pos - s.manualPos >= THEM_RECHECK_MS) {
      pushPhase(s, 'failed')
    }
  }

  return {
    level,
    /** a pause freezes the recording position; ticks are skipped until resume */
    paused(meetingId: string, on: boolean, at: number) {
      const s = sessions.get(meetingId)
      if (!s) return
      if (on && s.pausedAt == null) s.pausedAt = at
      else if (!on && s.pausedAt != null) { s.pauses.push([s.pausedAt, at]); s.pausedAt = null }
    },
    started(m: Pick<Meeting, 'id'> & { resume?: { startMs: number } }) {
      sessions.set(m.id, {
        id: m.id, baseWall: now(), basePos: m.resume?.startMs ?? 0, pauses: [], pausedAt: null,
        silentPos: null, stretchStart: null, stretchHadEvidence: false, lastMicWall: null,
        stage: 'idle', rebuiltPos: null, manualPos: null, phase: null, okUntilPos: null,
        ranges: [...d.loadRanges(m.id)],
      })
      d.publish(m.id)
    },
    stopped(id: string) {
      const s = sessions.get(id)
      if (!s) return
      sessions.delete(s.id)
      // whatever stretch was open ends with the recording
      if (s.pausedAt == null) closeStretch(s, posAt(s, now()))
      else closeStretch(s, posAt(s, s.pausedAt))
    },
    /** the banner's primary button: one rebuild now; 'ok' or 'failed' decides in 30 s of recording time */
    restart(id: string): boolean {
      const s = sessions.get(id)
      if (!s || (s.phase !== 'warn' && s.phase !== 'failed')) return false
      s.phase = 'restarting'
      s.manualPos = posAt(s, now())
      d.publish(id)
      log(`them silent: rebuild-system requested from the banner (${id})`)
      return d.rebuild(id)
    },
    /** "don't warn for this meeting": quiet app-side for this meeting only; the recorder keeps healing itself */
    mute(id: string) {
      muted.add(id)
      const s = sessions.get(id)
      if (s && (s.phase === 'warn' || s.phase === 'restarting' || s.phase === 'failed' || s.phase === 'ok')) pushPhase(s, null)
      d.publish(id)
    },
    unmute(id: string) {
      muted.delete(id)
      d.publish(id)
    },
    view(id: string): ThemView {
      const s = sessions.get(id)
      return { phase: s?.phase ?? null, muted: muted.has(id) }
    },
    /** tests: the silent ranges kept for the after-meeting note */
    ranges(id: string): Array<[number, number]> { return [...(sessions.get(id)?.ranges ?? [])] },
  }
}
export type ThemSilence = ReturnType<typeof createThemSilence>
