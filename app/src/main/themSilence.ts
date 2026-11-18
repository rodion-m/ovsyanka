import type { Meeting } from './store'
import type { ThemSilentPhase } from '../shared/types'

export const THEM_SILENT_MS = 60_000
export const THEM_RECHECK_MS = 30_000
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
type Session = { id: string; appBound: boolean; permissionAllowed: boolean; startMs: number; paused: boolean; lastMs: number; zeroStart: number | null; rangeStart: number | null; rangeQualified: boolean; rebuiltAt: number | null; manualAt: number | null; warned: boolean; phase: ThemSilentPhase | null; ranges: Array<[number, number]>; muted: boolean; notified: boolean }

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
  const qualify = (s: Session, w: ThemWatch) => {
    if ((!s.appBound && !w?.callApp) || !w || !s.permissionAllowed || !w.me || !w.other || w.participants.length < 2) return false
    if (w.participants.length >= 3 && w.speakingMe && !w.speakingOther) return false
    return true
  }
  const phase = (s: Session, next: ThemSilentPhase | null) => {
    if (s.phase === next) return
    s.phase = next; d.publish(s.id)
  }
  const saveRange = (s: Session, end: number) => {
    if (s.rangeStart == null || !s.rangeQualified) return
    const last = s.ranges.at(-1)
    if (last && s.rangeStart <= last[1] + 500) last[1] = Math.max(last[1], end)
    else s.ranges.push([s.rangeStart, end])
    persist(s)
  }
  return {
    level(id: string, frame: { ms: number; themZero: boolean; them?: number }) {
      if (d.enabled && !d.enabled()) return
      const s = sessions.get(id)
      if (!s || s.paused || !Number.isFinite(frame.ms) || frame.ms < s.lastMs) return
      const at = frame.ms; s.lastMs = at
      const w = d.watch(id)
      const allowed = qualify(s, w)
      if (!allowed || !frame.themZero) {
        if (s.rangeStart != null) saveRange(s, at)
        s.rangeStart = null; s.rangeQualified = false; s.zeroStart = null; s.rebuiltAt = null; s.warned = false
        if (!frame.themZero) phase(s, null)
        else if (!allowed) phase(s, null)
        return
      }
      if (s.rangeStart == null) s.rangeStart = at
      if (s.zeroStart == null) s.zeroStart = at
      const elapsed = at - s.zeroStart
      if (elapsed >= THEM_SILENT_MS) s.rangeQualified = true
      if (!d.warnEnabled() || s.muted) return
      if (s.phase === 'restarting' && s.manualAt != null && at - s.manualAt >= THEM_RECHECK_MS) phase(s, 'failed')
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
      s.paused = on; s.zeroStart = null; s.rebuiltAt = null; s.manualAt = null; s.warned = false
      if (on) phase(s, null)
    },
    permission(id: string, allowed: boolean) {
      const s = sessions.get(id)
      if (!s) return
      s.permissionAllowed = allowed
      if (!allowed) { if (s.rangeStart != null) saveRange(s, s.lastMs); s.zeroStart = null; s.rangeStart = null; s.rangeQualified = false; s.rebuiltAt = null; s.warned = false; phase(s, null) }
    },
    started(m: Pick<Meeting, 'id' | 'app'> & { resume?: { startMs: number } }) {
      const loaded = d.loadRanges(m.id)
      const saved: Saved = Array.isArray(loaded) ? { v: 2, ranges: loaded } : loaded
      const ranges = saved?.v === 2 && Array.isArray(saved.ranges) ? saved.ranges.filter(r => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]) : []
      const s: Session = { id: m.id, appBound: !!m.app, permissionAllowed: true, startMs: m.resume?.startMs ?? 0, paused: false, lastMs: m.resume?.startMs ?? 0, zeroStart: null, rangeStart: null, rangeQualified: false, rebuiltAt: null, manualAt: null, warned: false, phase: null, ranges, muted: saved?.muted === true, notified: saved?.notified === true }
      sessions.set(m.id, s); d.publish(m.id)
    },
    stopped(id: string) {
      const s = sessions.get(id)
      if (!s) return
      if (s.rangeStart != null) saveRange(s, s.lastMs)
      sessions.delete(id)
      // A completed meeting's warning state remains with its saved ranges for Resume.
      persist(s)
    },
    restart(id: string): boolean {
      const s = sessions.get(id)
      if (!s || !s.warned || s.paused) return false
      s.phase = 'restarting'; s.rebuiltAt = s.lastMs; s.manualAt = s.lastMs
      d.publish(id)
      log(`them track: manual system capture rebuild requested (${id})`)
      return d.rebuild(id)
    },
    mute(id: string) { const s = sessions.get(id); if (!s) return false; s.muted = true; persist(s); phase(s, null); return true },
    unmute(id: string) { const s = sessions.get(id); if (!s) return false; s.muted = false; persist(s); d.publish(id); return true },
    view(id: string): ThemView { const s = sessions.get(id); return { phase: s?.phase ?? null, muted: s?.muted ?? false } },
    ranges(id: string) { return [...(sessions.get(id)?.ranges ?? [])] },
    hasSession(id: string) { return sessions.has(id) },
  }
}
export type ThemSilence = ReturnType<typeof createThemSilence>
