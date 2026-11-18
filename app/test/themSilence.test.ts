import { describe, expect, it } from 'vitest'
import { createThemSilence, type ThemWatch } from '../src/main/themSilence'

const ME = 'Ari (Me)'
const OTHER = 'Morgan'
const TWO: ThemWatch = { callApp: true, participants: [ME, OTHER], me: true, other: true, speakingMe: false, speakingOther: false }

function rig(options: { app?: string | null; watch?: ThemWatch; permission?: boolean } = {}) {
  let watch = options.watch ?? TWO
  let now = 0
  let permitted = options.permission ?? true
  const saved = new Map<string, any>()
  const rebuilds: string[] = [], notices: string[] = []
  const wd = createThemSilence({
    warnEnabled: () => true,
    watch: () => watch,
    rebuild: id => { rebuilds.push(id); return true },
    notify: id => notices.push(id),
    publish: () => {},
    loadRanges: id => saved.get(id) ?? { v: 2, ranges: [] },
    saveRanges: (id, value) => saved.set(id, value),
  })
  wd.started({ id: 'm', app: options.app === undefined ? 'Zoom' : options.app })
  if (!permitted) wd.permission('m', false)
  const frame = (ms: number, themZero = true, them = 0) => wd.level('m', { ms, themZero, them })
  const ticks = async (from: number, duration: number, themZero = true, them = 0) => {
    for (let ms = from; ms <= from + duration; ms += 100) { now = ms; frame(ms, themZero, them); await Promise.resolve() }
  }
  return { wd, saved, rebuilds, notices, frame, ticks, setWatch: (v: ThemWatch) => { watch = v }, setPermitted: (v: boolean) => { permitted = v; wd.permission('m', v) }, get now() { return now } }
}

describe('digital silence promises', () => {
  it('incident: rebuilds at 60 seconds and warns once at 90 seconds with file-time range', async () => {
    const r = rig({ watch: TWO })
    await r.ticks(240_000, 90_000)
    expect(r.rebuilds).toEqual(['m', 'm'])
    expect(r.notices).toEqual(['m'])
    r.wd.stopped('m')
    expect(r.saved.get('m')).toMatchObject({ v: 2, ranges: [[240_000, 330_000]] })
  })

  it('healthy quiet call: low but nonzero sound over ten minutes does nothing', async () => {
    const r = rig()
    await r.ticks(0, 600_000, false, 0) // -70 dBFS maps to zero on the level display; it is not digital zero
    expect(r.rebuilds).toEqual([]); expect(r.notices).toEqual([])
  })

  it('manual recording without a call app does nothing', async () => {
    const r = rig({ app: null, watch: { ...TWO, callApp: false } })
    await r.ticks(0, 120_000)
    expect(r.rebuilds).toEqual([]); expect(r.notices).toEqual([])
  })

  it('alone: a roster containing only me does nothing', async () => {
    const r = rig({ watch: { callApp: true, participants: [ME], me: true, other: false, speakingMe: false, speakingOther: false } })
    await r.ticks(0, 120_000)
    expect(r.rebuilds).toEqual([])
  })

  it('one participant who is not me is unknown and does nothing', async () => {
    const r = rig({ watch: { callApp: true, participants: [OTHER], me: false, other: true, speakingMe: false, speakingOther: false } })
    await r.ticks(0, 120_000)
    expect(r.rebuilds).toEqual([])
  })

  it('solo presenter in a 3+ call stays quiet while the reader marks only me', async () => {
    const r = rig({ watch: { callApp: true, participants: [ME, OTHER, 'Lee'], me: true, other: true, speakingMe: true, speakingOther: false } })
    await r.ticks(0, 120_000)
    expect(r.rebuilds).toEqual([]); expect(r.notices).toEqual([])
  })

  it('another marked speaker in a 3+ call warns after the first failed rebuild check', async () => {
    const r = rig()
    await r.ticks(0, 60_000)
    r.setWatch({ callApp: true, participants: [ME, OTHER, 'Lee'], me: true, other: true, speakingMe: false, speakingOther: true })
    await r.ticks(60_000, 30_000)
    expect(r.rebuilds).toEqual(['m', 'm']); expect(r.notices).toEqual(['m'])
  })

  it('pause preserves file-time endpoints including the ten-minute pause', async () => {
    const r = rig()
    await r.ticks(0, 70_000)
    r.wd.paused('m', true)
    r.wd.paused('m', false)
    await r.ticks(670_000, 20_000)
    r.wd.stopped('m')
    expect(r.saved.get('m').ranges).toEqual([[0, 690_000]])
  })

  it('resume after restart retains mute and appends ranges on the same file timeline', async () => {
    const r = rig()
    r.wd.mute('m')
    await r.ticks(0, 70_000)
    r.wd.stopped('m')
    r.wd.started({ id: 'm', app: 'Zoom', resume: { startMs: 70_000 } })
    await r.ticks(70_000, 60_000)
    expect(r.wd.view('m').muted).toBe(true)
    expect(r.rebuilds).toEqual([])
    r.wd.stopped('m')
    expect(r.saved.get('m').ranges).toEqual([[0, 130_000]])
  })

  it('permission denied: no rebuild, banner, notification, or range', async () => {
    const r = rig({ permission: false })
    await r.ticks(0, 120_000)
    r.wd.stopped('m')
    expect(r.rebuilds).toEqual([]); expect(r.notices).toEqual([])
    expect(r.saved.get('m').ranges).toEqual([])
  })
})
