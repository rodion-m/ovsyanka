import { t } from './i18n'
import { formatElapsed } from './wave'

/** silent stretches shorter than this together are not worth a note after the meeting */
export const THEM_SILENT_NOTICE_MS = 120_000
/** at most this many stretches are spelled out; the rest are counted */
const RANGES_SHOWN = 3

export type ThemSilentRecord = { ranges: Array<[number, number]> }

/** total milliseconds of silent stretches (recording time) */
export function themSilentTotal(rec: ThemSilentRecord | undefined): number {
  return (rec?.ranges ?? []).reduce((n, [a, b]) => n + Math.max(0, b - a), 0)
}

/**
 * The calm after-meeting line about the other side's track being silent, or null while the total
 * stays under the threshold. Times are positions in the recording.
 */
export function themSilentText(rec: ThemSilentRecord | undefined): string | null {
  const ranges = (rec?.ranges ?? []).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  if (themSilentTotal({ ranges }) <= THEM_SILENT_NOTICE_MS) return null
  const shown = ranges.slice(0, RANGES_SHOWN).map(([a, b]) => t('from {start} to {end}', { start: formatElapsed(a), end: formatElapsed(b) }))
  const rest = ranges.length - shown.length
  const list = shown.join(', ') + (rest > 0 ? ` ${t('and {n} more', { n: rest })}` : '')
  return t("The other side's sound wasn't recorded {ranges} — their lines are missing from the transcript for that time.", { ranges: list })
}
