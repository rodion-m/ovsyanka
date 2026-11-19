import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { themSilentText, themSilentTotal } from '../src/shared/themSilent'
import { setLanguage } from '../src/shared/i18n'
import { ThemSilence } from '../src/renderer/src/components/ThemSilence'

describe('silent range notice', () => {
  it('renders the active warning in Russian without a snapshot', () => {
    setLanguage('ru')
    const view = { kind: 'recording' as const, meetingId: 'm', title: 'Встреча', elapsedMs: 90_000, at: 0, note: { tone: 'hint' as const, text: "Can't hear the other side", code: 'them-silent' as const, them: 'warn' as const }, crashed: false }
    const html = renderToStaticMarkup(createElement(ThemSilence, { view }))
    expect(html).toContain('Не слышно собеседника')
    expect(html).toContain('Перезапустить захват звука')
    expect(html).toContain('Не предупреждать на этой встрече')
    setLanguage('en')
  })
  it('does not show while recording and shows the conditional wording after the meeting ends', () => {
    const record = { v: 2 as const, ranges: [[223_000, 3_840_000] as [number, number]] }
    expect(themSilentText(record, false)).toBeNull()
    expect(themSilentText(record)).toBe("The other side's sound wasn't recorded from 3:43 to 1:04:00. If someone spoke then, their words are not in the transcript.")
  })
  it('uses file times, including pauses, and only valid ranges contribute', () => {
    expect(themSilentTotal({ v: 2, ranges: [[0, 10], [20, 10]] })).toBe(10)
    expect(themSilentText({ v: 2, ranges: [[1_000, 61_000]] })).toContain('from 0:01 to 1:01')
  })
})
