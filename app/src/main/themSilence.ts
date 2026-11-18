import type { Meeting } from './store'
import type { ThemSilentPhase } from '../shared/types'

export const THEM_SILENT_MS = 60_000
export const THEM_RECHECK_MS = 30_000
const READER_GRACE_MS = 10_000
const OK_MS = 4_000
export type ThemWatch = {
  callApp: boolean
  participants: string[]
  me: boolean
  other: boolean
  speakingMe: boolean
  speakingOther: boolean
} | null
export type ThemView = { phase: ThemSilentPhase | null; muted: boolean }
type Saved = { v: 2; ranges: Array<[number, number]>; muted?: boolean; notified?: boolean }
type Session = {
  id: string; app: string | null; permissionAllowed: boolean; paused: boolean; lastMs: number
  zeroStart: number | null; rangeStart: number | null; rangeQualified: boolean
  disqualifiedAt: number | null; rebuiltAt: number | null
  warned: boolean; phase: ThemSilentPhase | null; okUntil: number | null; restartingAt: number | null
  ranges: Array<[number, number]>; muted: boolean; notified: boolean
}

export function createThemSilence(d: {
  enabled?(): boolean
  warnEnabled(): boolean
  watch(id: string): ThemWatch
  rebuild(id: string): boolean
  notify(id: string): void
  publish(id: string): void
  loadRanges(id: string): Saved | Array<[number, number]>
  saveRanges(id: string, value: Saved): void
  log?(msg: string): void
}) {
  const sessions = new Map<string, Session>()
  const log = (msg: string) => d.log?.(msg)
  const persist = (s: Session) => d.saveRanges(s.id, { v: 2, ranges: s.ranges, ...(s.muted ? { muted: true } : {}), ...(s.notified ? { notified: true } : {}) })
  const hasCall = (s: Session, w: ThemWatch) => !!s.app && !!w?.callApp && w.me && w.other && w.participants.length >= 2
  const suppressed = (w: ThemWatch) => !!w && w.participants.length >= 3 && w.speakingMe && !w.speakingOther
  const phase = (s: Session, next: ThemSilentPhase | null) => {
    if (s.phase === next) return
    s.phase = next
    d.publish(s.id)
  }
  const saveRange = (s: Session, end: number) => {
    if (s.rangeStart == null || !s.rangeQualified) return
    const last = s.ranges.at(-1)
    if (last && s.rangeStart <= last[1] + 500) {
      if (end <= last[1]) return
      last[1] = end
    } else s.ranges.push([s.rangeStart, end])
    persist(s)
  }
  const clearStretch = (s: Session, at: number) => {
    saveRange(s, at)
    s.rangeStart = null; s.rangeQualified = false; s.zeroStart = null
    s.disqualifiedAt = null; s.rebuiltAt = null; s.warned = false
  }
  return {
    level(id: string, frame: { ms: number; themZero: boolean; them?: number; noBuffers?: boolean }) {
      if (d.enabled && !d.enabled()) return
      const s = sessions.get(id)
      if (!s || s.paused || !Number.isFinite(frame.ms) || frame.ms < s.lastMs) return
      const at = frame.ms
      s.lastMs = at
      if (!frame.themZero) s.permissionAllowed = true
      if (s.phase === 'ok' && s.okUntil != null && at >= s.okUntil) { s.okUntil = null; phase(s, null) }

      if (!frame.themZero) {
        const recover = s.phase === 'warn' || s.phase === 'restarting' || s.phase === 'failed'
        clearStretch(s, at)
        if (recover) { s.okUntil = at + OK_MS; phase(s, 'ok') }
        else if (s.phase !== 'ok') phase(s, null)
        return
      }

      if (s.phase === 'restarting' && s.restartingAt != null && at - s.restartingAt >= THEM_RECHECK_MS) phase(s, 'failed')

      const w = d.watch(id)
      if (!s.permissionAllowed) { if (s.phase != null) phase(s, null); return }
      const qualified = hasCall(s, w)
      if (!qualified) {
        if (w == null) {
          if (s.zeroStart == null) return
        } else {
          s.disqualifiedAt ??= at
          if (at - s.disqualifiedAt >= READER_GRACE_MS) { clearStretch(s, s.disqualifiedAt); phase(s, null); return }
          else if (s.zeroStart == null) return
        }
      } else {
        s.disqualifiedAt = null
      }

      if (s.zeroStart == null) s.zeroStart = at
      if (qualified && s.rangeStart == null) s.rangeStart = at
      const elapsed = at - s.zeroStart
      if (s.rangeStart != null && at - s.rangeStart >= THEM_SILENT_MS) s.rangeQualified = true
      // A missing or temporarily invalid reader sample keeps an established stretch alive for ten seconds.
      // It cannot start a new warning until the call is identified again.
      if (!qualified || !s.rangeQualified || !d.warnEnabled() || s.muted || suppressed(w)) {
        if (!d.warnEnabled() && s.phase != null) phase(s, null)
        return
      }
      if (s.rebuiltAt == null && elapsed >= THEM_SILENT_MS) {
        s.rebuiltAt = at
        log(`them track: exact zeros for 60 s in qualifying call; rebuilding system capture (${id})`)
        d.rebuild(id)
        return
      }
      if (!s.warned && s.rebuiltAt != null && at - s.rebuiltAt >= THEM_RECHECK_MS) {
        s.warned = true
        d.rebuild(id)
        phase(s, 'warn')
        if (!s.notified) { s.notified = true; persist(s); d.notify(id) }
      }
    },
    paused(id: string, on: boolean) {
      const s = sessions.get(id)
      if (!s || s.paused === on) return
      s.paused = on; s.zeroStart = null; s.disqualifiedAt = null; s.rebuiltAt = null; s.warned = false
      if (on) phase(s, null)
    },
    permission(id: string, allowed: boolean) {
      const s = sessions.get(id)
      if (!s) return
      s.permissionAllowed = allowed
      if (!allowed) { clearStretch(s, s.lastMs); phase(s, null) }
    },
    setting(on: boolean) {
      if (on) return
      for (const s of sessions.values()) phase(s, null)
    },
    started(m: Pick<Meeting, 'id' | 'app'> & { resume?: { startMs: number } }) {
      const loaded = d.loadRanges(m.id)
      const saved: Saved = Array.isArray(loaded) ? { v: 2, ranges: loaded } : loaded
      const ranges = saved?.v === 2 && Array.isArray(saved.ranges) ? saved.ranges.filter(r => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]) : []
      const s: Session = { id: m.id, app: m.app, permissionAllowed: true, paused: false, lastMs: m.resume?.startMs ?? 0, zeroStart: null, rangeStart: null, rangeQualified: false, disqualifiedAt: null, rebuiltAt: null, warned: false, phase: null, okUntil: null, restartingAt: null, ranges, muted: saved?.muted === true, notified: saved?.notified === true }
      sessions.set(m.id, s); d.publish(m.id)
    },
    bindApp(id: string, app: string | null) { const s = sessions.get(id); if (s) s.app = app },
    stopped(id: string) {
      const s = sessions.get(id)
      if (!s) return
      if (s.rangeStart != null) saveRange(s, s.lastMs)
      sessions.delete(id)
    },
    restart(id: string): boolean {
      const s = sessions.get(id)
      if (!s || !d.warnEnabled() || !s.warned || s.paused) return false
      s.phase = 'restarting'; s.restartingAt = s.lastMs; s.rebuiltAt = s.lastMs
      d.publish(id)
      log(`them track: manual system capture rebuild requested (${id})`)
      return d.rebuild(id)
    },
    mute(id: string) { const s = sessions.get(id); if (!s) return false; if (s.muted) return true; s.muted = true; persist(s); phase(s, null); return true },
    unmute(id: string) {
      const s = sessions.get(id); if (!s) return false
      if (!s.muted) return true
      s.muted = false; persist(s)
      if (s.warned && s.zeroStart != null && s.rangeQualified && d.warnEnabled()) phase(s, 'warn')
      else d.publish(id)
      return true
    },
    view(id: string): ThemView { const s = sessions.get(id); return { phase: s?.phase ?? null, muted: s?.muted ?? false } },
    hasSession(id: string) { return sessions.has(id) },
  }
}
export type ThemSilence = ReturnType<typeof createThemSilence>
