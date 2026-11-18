import { describe, expect, it } from 'vitest'
import { THEM_SILENT_NOTICE_MS, themSilentText, themSilentTotal } from '../src/shared/themSilent'

const min = (n: number) => n * 60_000

describe('themSilentTotal', () => {
  it('sums the stretches, ignoring broken ones', () => {
    expect(themSilentTotal(undefined)).toBe(0)
    expect(themSilentTotal({ ranges: [] })).toBe(0)
    expect(themSilentTotal({ ranges: [[0, min(1)], [min(2), min(3)], [min(4), min(4) - 1]] })).toBe(min(2))
  })
})

describe('themSilentText', () => {
  it('says nothing at or under two minutes of silence in all', () => {
    expect(themSilentText(undefined)).toBeNull()
    expect(themSilentText({ ranges: [] })).toBeNull()
    expect(themSilentText({ ranges: [[min(1), min(3)]] })).toBeNull() // exactly two minutes
    expect(themSilentText({ ranges: [[0, min(1)], [min(5), min(6)]] })).toBeNull() // two one-minute stretches
    expect(themSilentText({ ranges: [[0, min(1)], [min(5), min(6.5)]] })).not.toBeNull()
  })

  it('spells out one stretch with recording times', () => {
    const text = themSilentText({ ranges: [[min(3) + 43_000, min(66) + 10_000]] })
    expect(text).toBe("The other side's sound wasn't recorded from 3:43 to 1:06:10 — their lines are missing from the transcript for that time.")
  })

  it('joins several stretches with commas, sorted by start', () => {
    const text = themSilentText({ ranges: [[min(10), min(13)], [min(1), min(4)]] })
    expect(text).toBe("The other side's sound wasn't recorded from 1:00 to 4:00, from 10:00 to 13:00 — their lines are missing from the transcript for that time.")
  })

  it('shows at most three stretches and counts the rest', () => {
    const ranges: Array<[number, number]> = [
      [min(1), min(4)], [min(6), min(9)], [min(12), min(15)], [min(20), min(23)], [min(30), min(33)],
    ]
    const text = themSilentText({ ranges })
    expect(text).toContain('from 1:00 to 4:00, from 6:00 to 9:00, from 12:00 to 15:00 and 2 more')
    expect(text).not.toContain('20:00')
    expect(text).toContain("their lines are missing from the transcript")
  })

  it('stays under the threshold when broken or overlapping stretches inflate the count', () => {
    expect(themSilentText({ ranges: [[0, -5], [0, THEM_SILENT_NOTICE_MS - 1]] })).toBeNull()
  })
})
