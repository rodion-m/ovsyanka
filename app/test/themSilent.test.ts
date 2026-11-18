import { describe, expect, it } from 'vitest'
import { themSilentText, themSilentTotal } from '../src/shared/themSilent'

describe('silent range notice', () => {
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
