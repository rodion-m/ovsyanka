import { describe, expect, it } from 'vitest'
import { createThemSilence, type ThemWatch } from '../src/main/themSilence'

const ME = 'Ari (Me)'
const OTHER = 'Morgan'
const TWO: ThemWatch = { callApp: true, participants: [ME, OTHER], me: true, other: true, speakingMe: false, speakingOther: false }
const SOLO: ThemWatch = { callApp: true, participants: [ME, OTHER, 'Lee'], me: true, other: true, speakingMe: true, speakingOther: false }
function rig(options: { app?: string | null; watch?: ThemWatch; permission?: boolean } = {}) {
  let watch = options.watch === undefined ? TWO : options.watch
  let warnEnabled = true
  const saved = new Map<string, any>()
  const rebuilds: string[] = [], notices: string[] = [], published: Array<{ phase: string | null; muted: boolean }> = []
  let saves = 0
  const wd = createThemSilence({
    warnEnabled: () => warnEnabled,
    watch: () => watch,
    rebuild: id => { rebuilds.push(id); return true },
    notify: id => notices.push(id),
    publish: id => published.push(wd.view(id)),
    loadRanges: id => saved.get(id) ?? { v: 2, ranges: [] },
    saveRanges: (id, value) => { saves++; saved.set(id, value) },
  })
  wd.started({ id: 'm', app: options.app === undefined ? 'Zoom' : options.app })
  if (options.permission === false) wd.permission('m', false)
  const frame = (ms: number, themZero = true, them = 0, noBuffers = false) => wd.level('m', { ms, themZero, them, noBuffers })
  const ticks = (from: number, duration: number, zero = true, them = 0) => {
    for (let ms = from; ms <= from + duration; ms += 100) frame(ms, zero, them)
  }
  return { wd, saved, rebuilds, notices, published, frame, ticks, saves: () => saves, setWatch: (v: ThemWatch) => { watch = v }, setWarn: (v: boolean) => { warnEnabled = v }, setPermitted: (v: boolean) => wd.permission('m', v) }
}

describe('digital silence promises', () => {
  it('incident: rebuilds at 60 seconds and warns once at 90 seconds with a file-time range', () => {
    const r = rig()
    r.ticks(240_000, 90_000)
    expect(r.rebuilds).toEqual(['m', 'm']); expect(r.notices).toEqual(['m'])
    r.wd.stopped('m')
    expect(r.saved.get('m')).toMatchObject({ v: 2, ranges: [[240_000, 330_000]] })
  })

  it('healthy quiet call: low but nonzero sound over ten minutes does nothing', () => {
    const r = rig(); r.ticks(0, 600_000, false, 0.0003) // about -70 dBFS
    expect(r.rebuilds).toEqual([]); expect(r.notices).toEqual([])
  })

  it('manual recording with a background call does not qualify without a meeting app binding', () => {
    const r = rig({ app: null })
    r.ticks(0, 120_000)
    expect(r.rebuilds).toEqual([]); expect(r.notices).toEqual([])
  })

  it('alone: a roster containing only me does nothing', () => {
    const r = rig({ watch: { callApp: true, participants: [ME], me: true, other: false, speakingMe: false, speakingOther: false } })
    r.ticks(0, 120_000); expect(r.rebuilds).toEqual([])
  })

  it('one participant who is not me is unknown and does nothing', () => {
    const r = rig({ watch: { callApp: true, participants: [OTHER], me: false, other: true, speakingMe: false, speakingOther: false } })
    r.ticks(0, 120_000); expect(r.rebuilds).toEqual([])
  })

  it('a one-frame reader gap does not split the range or delay the 90-second warning', () => {
    const r = rig()
    r.ticks(240_000, 75_000); r.setWatch(null); r.frame(315_100); r.setWatch(TWO); r.ticks(315_200, 14_800)
    expect(r.rebuilds).toEqual(['m', 'm']); expect(r.notices).toEqual(['m'])
    r.wd.stopped('m'); expect(r.saved.get('m').ranges).toEqual([[240_000, 330_000]])
  })

  it('an unreadable reader gap over ten seconds cannot disqualify or reset an existing zero stretch', () => {
    const r = rig(); r.ticks(0, 60_000); r.setWatch(null); r.ticks(60_100, 29_900)
    expect(r.notices).toEqual([])
    r.setWatch(TWO); r.frame(90_100)
    expect(r.rebuilds).toEqual(['m', 'm']); expect(r.notices).toEqual(['m'])
    r.wd.stopped('m'); expect(r.saved.get('m').ranges).toEqual([[0, 90_100]])
  })

  it('15 seconds of definite disqualification ends the stretch and its range', () => {
    const r = rig(); r.ticks(0, 70_000)
    r.setWatch({ ...TWO, participants: [ME], other: false })
    r.ticks(70_000, 15_000)
    r.setWatch(TWO); r.ticks(85_000, 89_900)
    expect(r.notices).toEqual([])
    r.ticks(175_000, 30_000)
    expect(r.notices).toEqual(['m'])
    r.wd.stopped('m'); expect(r.saved.get('m').ranges).toEqual([[0, 70_000], [85_000, 205_000]])
  })

  it('solo-presenter suppression blocks rebuilding and warning, then another speaker rebuilds immediately', () => {
    const r = rig({ watch: SOLO }); r.ticks(0, 300_000)
    expect(r.rebuilds).toEqual([]); expect(r.notices).toEqual([])
    r.setWatch({ ...SOLO, speakingMe: false, speakingOther: true }); r.frame(300_100)
    expect(r.rebuilds).toEqual(['m']); expect(r.notices).toEqual([])
    r.ticks(300_200, 30_000)
    expect(r.rebuilds).toEqual(['m', 'm']); expect(r.notices).toEqual(['m'])
  })

  it('pause preserves file-time endpoints including the ten-minute pause', () => {
    const r = rig(); r.ticks(0, 70_000); r.wd.paused('m', true); r.wd.paused('m', false)
    r.ticks(670_000, 20_000); r.wd.stopped('m')
    expect(r.saved.get('m').ranges).toEqual([[0, 690_000]])
  })

  it('resume after restart retains mute and appends ranges on the same file timeline', () => {
    const r = rig(); r.wd.mute('m'); r.ticks(0, 70_000); r.wd.stopped('m')
    r.wd.started({ id: 'm', app: 'Zoom', resume: { startMs: 70_000 } }); r.ticks(70_000, 60_000)
    expect(r.wd.view('m').muted).toBe(true); expect(r.rebuilds).toEqual([])
    r.wd.stopped('m'); expect(r.saved.get('m').ranges).toEqual([[0, 130_000]])
  })

  it('does not persist an empty silence record, and repeated mute changes write only once', () => {
    const r = rig(); r.ticks(0, 1_000); r.wd.stopped('m')
    expect(r.saved.has('m')).toBe(false); expect(r.saves()).toBe(0)
    r.wd.started({ id: 'm', app: 'Zoom' }); r.wd.mute('m'); r.wd.mute('m')
    expect(r.saves()).toBe(1)
  })

  it('permission loss clears the stretch and recovery permits new nonzero frames', () => {
    const r = rig(); r.ticks(0, 20_000); r.setPermitted(false); r.ticks(20_000, 90_000)
    expect(r.rebuilds).toEqual([])
    r.frame(110_100, false, 0.01); r.ticks(110_200, 90_000)
    expect(r.notices).toEqual(['m'])
  })

  it('sound returning after warn shows ok for four seconds on the frame clock', () => {
    const r = rig(); r.ticks(0, 90_000); expect(r.wd.view('m').phase).toBe('warn')
    r.frame(90_100, false, 0.1); expect(r.wd.view('m').phase).toBe('ok')
    r.frame(94_000, false, 0.1); expect(r.wd.view('m').phase).toBe('ok')
    r.frame(94_100, false, 0.1); expect(r.wd.view('m').phase).toBeNull()
  })

  it('manual restart becomes failed after 30 seconds, then sound returning shows ok', () => {
    const r = rig(); r.ticks(0, 90_000)
    expect(r.wd.restart('m')).toBe(true); expect(r.wd.view('m').phase).toBe('restarting')
    r.ticks(90_000, 30_000); expect(r.wd.view('m').phase).toBe('failed')
    r.frame(120_100, false, 0.1); expect(r.wd.view('m').phase).toBe('ok')
  })

  it('turning warnings off clears and publishes the phase, and restart stays disabled', () => {
    const r = rig(); r.ticks(0, 90_000); expect(r.wd.view('m').phase).toBe('warn')
    const n = r.published.length; r.setWarn(false); r.wd.setting(false)
    expect(r.wd.view('m').phase).toBeNull(); expect(r.published.length).toBe(n + 1)
    expect(r.wd.restart('m')).toBe(false)
  })

  it('Undo restores warn while the stretch qualifies without sending a second notification', () => {
    const r = rig(); r.ticks(0, 90_000); expect(r.notices).toHaveLength(1)
    r.wd.mute('m'); expect(r.wd.view('m').muted).toBe(true)
    r.wd.unmute('m'); expect(r.wd.view('m')).toEqual({ phase: 'warn', muted: false })
    expect(r.notices).toHaveLength(1)
  })
})
