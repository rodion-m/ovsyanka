import { describe, expect, it } from 'vitest'
import { createThemSilence, THEM_SILENT_MS, THEM_RECHECK_MS, type ThemWatch } from '../src/main/themSilence'

/**
 * The silent-"them" watchdog over a fake clock: levels arrive as 10 Hz ticks, each 100 ms of wall
 * and recording time. `them` at 0 is the dead track; 0.5 is sound.
 */
function rig(opts: { watch?: ThemWatch; warn?: boolean } = {}) {
  let t = 0
  let call = false
  let watch: ThemWatch = opts.watch ?? null
  let warn = opts.warn ?? true
  const rebuilds: string[] = []
  const notices: string[] = []
  const saved = new Map<string, Array<[number, number]>>()
  const published = new Set<string>()
  const ts = createThemSilence({
    now: () => t,
    warnEnabled: () => warn,
    callOn: () => call,
    watch: () => watch,
    rebuild: (id) => { rebuilds.push(id); return true },
    notify: (id) => { notices.push(id) },
    publish: (id) => { published.add(id) },
    loadRanges: (id) => saved.get(id) ?? [],
    saveRanges: (id, r) => { saved.set(id, r) },
  })
  return {
    ts, rebuilds, notices, saved, published,
    setT: (v: number) => { t = v }, getT: () => t,
    setCall: (v: boolean) => { call = v }, setWatch: (w: ThemWatch) => { watch = w }, setWarn: (v: boolean) => { warn = v },
  }
}

/** `ms` of wall/recording time in 100 ms level ticks for meeting `id` */
function ticks(r: ReturnType<typeof rig>, ms: number, me = 0, them = 0, id = 'm1') {
  for (let i = 0; i < ms; i += 100) { r.setT(r.getT() + 100); r.ts.level(id, me, them) }
}
const TWO = { participants: 2, sawSpeakers: false, otherTalkedAt: null } as const

describe('the silent-"them" watchdog', () => {
  it('does nothing without a call, even with speech and a dead them track', () => {
    const r = rig()
    r.ts.started({ id: 'm1' })
    ticks(r, 130_000, 0.5, 0)
    expect(r.rebuilds).toEqual([])
    expect(r.notices).toEqual([])
    expect(r.ts.view('m1')).toEqual({ phase: null, muted: false })
  })

  it('does not fire on genuine silence: a call, a dead track, nobody talking', () => {
    const r = rig({ watch: { participants: 2, sawSpeakers: true, otherTalkedAt: null } })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, 130_000, 0, 0)
    expect(r.rebuilds).toEqual([])
    expect(r.ts.view('m1').phase).toBeNull()
  })

  it('a lone participant in the call never warns', () => {
    const r = rig({ watch: { participants: 1, sawSpeakers: true, otherTalkedAt: 1 } })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, 130_000, 0.5, 0)
    expect(r.rebuilds).toEqual([])
    expect(r.notices).toEqual([])
  })

  it('once the reader saw speakers, only someone else talking is evidence — a solo presenter stays quiet', () => {
    const r = rig({ watch: { participants: 2, sawSpeakers: true, otherTalkedAt: null } })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    // the person talks the whole time; the reader sees only them
    ticks(r, 130_000, 0.5, 0)
    expect(r.rebuilds).toEqual([])
    expect(r.notices).toEqual([])
  })

  it('fires at 60 s of them-silence with mic speech when the reader reports no speakers', () => {
    const r = rig({ watch: TWO })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, THEM_SILENT_MS - 1_000, 0.5, 0.5) // sound and speech first
    ticks(r, THEM_SILENT_MS - 1_000, 0.5, 0) // them dies, me keeps talking
    expect(r.rebuilds).toEqual([])
    ticks(r, 1_100, 0.5, 0)
    expect(r.rebuilds).toEqual(['m1'])
    expect(r.ts.view('m1').phase).toBeNull() // still inside the recheck window
  })

  it('fires on the call reader\'s "someone else talked" even with a quiet mic', () => {
    const r = rig()
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    // sound first, then them dies; the reader saw the other side talk a moment ago (wall ms)
    ticks(r, 5_000, 0, 0.5)
    r.setWatch({ participants: 2, sawSpeakers: true, otherTalkedAt: r.getT() })
    ticks(r, THEM_SILENT_MS + 500, 0, 0)
    expect(r.rebuilds).toEqual(['m1'])
  })

  it('warns 30 s after the first rebuild, sends one more, then stops automatic rebuilds', () => {
    const r = rig({ watch: TWO })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, THEM_SILENT_MS + 1_000, 0.5, 0)
    expect(r.rebuilds).toEqual(['m1'])
    ticks(r, THEM_RECHECK_MS - 1_000, 0.5, 0)
    expect(r.ts.view('m1').phase).toBeNull()
    ticks(r, 1_100, 0.5, 0)
    expect(r.rebuilds).toEqual(['m1', 'm1'])
    expect(r.ts.view('m1').phase).toBe('warn')
    expect(r.notices).toEqual(['m1'])
    // warned: no more automatic rebuilds for this meeting
    ticks(r, 120_000, 0.5, 0)
    expect(r.rebuilds).toEqual(['m1', 'm1'])
    expect(r.notices).toEqual(['m1'])
  })

  it('clears the alert when sound returns and re-arms after it', () => {
    const r = rig({ watch: TWO })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, THEM_SILENT_MS + THEM_RECHECK_MS + 1_000, 0.5, 0)
    expect(r.ts.view('m1').phase).toBe('warn')
    ticks(r, 1_000, 0.5, 0.5)
    expect(r.ts.view('m1').phase).toBe('ok')
    ticks(r, 5_000, 0.5, 0.5)
    expect(r.ts.view('m1').phase).toBeNull()
    // them dies again: the whole cycle repeats
    ticks(r, THEM_SILENT_MS + 1_000, 0.5, 0)
    expect(r.rebuilds).toEqual(['m1', 'm1', 'm1'])
  })

  it('restart from the banner: restarting, then ok on sound or failed after 30 s', () => {
    const r = rig({ watch: TWO })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, THEM_SILENT_MS + THEM_RECHECK_MS + 1_000, 0.5, 0)
    expect(r.ts.view('m1').phase).toBe('warn')
    expect(r.ts.restart('m1')).toBe(true)
    expect(r.rebuilds).toEqual(['m1', 'm1', 'm1'])
    expect(r.ts.view('m1').phase).toBe('restarting')
    ticks(r, 2_000, 0.5, 0.5)
    expect(r.ts.view('m1').phase).toBe('ok')
    // and the failure path: let the success line expire first, then them dies again
    ticks(r, 5_000, 0.5, 0.5)
    ticks(r, THEM_SILENT_MS + THEM_RECHECK_MS + 1_000, 0.5, 0)
    expect(r.ts.view('m1').phase).toBe('warn')
    r.ts.restart('m1')
    ticks(r, THEM_RECHECK_MS - 1_000, 0.5, 0)
    expect(r.ts.view('m1').phase).toBe('restarting')
    ticks(r, 1_100, 0.5, 0)
    expect(r.ts.view('m1').phase).toBe('failed')
    // failed keeps both actions: another restart is allowed
    expect(r.ts.restart('m1')).toBe(true)
  })

  it('"don\'t warn for this meeting" quiets this meeting only; undo brings the alert back', () => {
    const r = rig({ watch: TWO })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, THEM_SILENT_MS + THEM_RECHECK_MS + 1_000, 0.5, 0)
    expect(r.ts.view('m1').phase).toBe('warn')
    r.ts.mute('m1')
    expect(r.ts.view('m1')).toEqual({ phase: null, muted: true })
    // silence continues: nothing more is sent or shown for m1
    ticks(r, 60_000, 0.5, 0)
    expect(r.rebuilds).toEqual(['m1', 'm1'])
    expect(r.ts.view('m1').phase).toBeNull()
    // the next meeting is not muted
    r.ts.started({ id: 'm2' })
    ticks(r, THEM_SILENT_MS + THEM_RECHECK_MS + 1_000, 0.5, 0, 'm2')
    expect(r.ts.view('m2').phase).toBe('warn')
    // undo on m1 restores its alert while conditions still hold
    r.ts.unmute('m1')
    expect(r.ts.view('m1').muted).toBe(false)
    ticks(r, 500, 0.5, 0)
    expect(r.ts.view('m1').phase).toBe('warn')
  })

  it('the setting off stops every app-side action but keeps recording the silent ranges', () => {
    const r = rig({ watch: TWO, warn: false })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, 130_000, 0.5, 0)
    expect(r.rebuilds).toEqual([])
    expect(r.notices).toEqual([])
    expect(r.ts.view('m1').phase).toBeNull()
    // the honest record still accumulates: over two minutes of qualifying silence
    r.ts.stopped('m1')
    const ranges = r.saved.get('m1') ?? []
    expect(ranges.reduce((n, [a, b]) => n + b - a, 0)).toBeGreaterThan(120_000)
  })

  it('keeps at most one notification per meeting, across re-arms', () => {
    const r = rig({ watch: TWO })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    for (let i = 0; i < 2; i++) {
      ticks(r, THEM_SILENT_MS + THEM_RECHECK_MS + 2_000, 0.5, 0)
      expect(r.ts.view('m1').phase).toBe('warn')
      ticks(r, 1_000, 0.5, 0.5) // sound back
      ticks(r, 5_000, 0.5, 0.5)
    }
    expect(r.notices).toEqual(['m1'])
  })

  it('records silent stretches only while the warning conditions held, and resumes keep them', () => {
    const r = rig({ watch: TWO })
    r.setCall(true)
    r.ts.started({ id: 'm1' })
    ticks(r, 10_000, 0.5, 0.5)
    ticks(r, 70_000, 0.5, 0) // a qualifying silent stretch
    ticks(r, 10_000, 0.5, 0.5)
    const ranges = r.ts.ranges('m1')
    expect(ranges).toHaveLength(1)
    expect(ranges[0][0]).toBeGreaterThanOrEqual(9_000)
    expect(ranges[0][1] - ranges[0][0]).toBeGreaterThan(60_000)
    expect(r.saved.get('m1')).toEqual(ranges)
    // the meeting stops and resumes: the kept ranges load back
    r.ts.stopped('m1')
    r.ts.started({ id: 'm1', resume: { startMs: 90_000 } })
    ticks(r, 5_000, 0.5, 0.5, 'm1')
    expect(r.ts.ranges('m1')).toEqual(ranges)
  })
})

