import { recoverTranscription } from './asr'

/** what a recovered transcript feeds back into: unedited notes are written again and the library re-indexed */
export type TranscriptFollowUp = {
  segmentCount: (id: string) => number
  applyTranscript: (id: string, force?: boolean) => unknown
  scheduleIndex: () => unknown
  /** for tests: stand in for the real recovery */
  recover?: (id: string, o?: { retry?: boolean }) => Promise<void>
}

/**
 * Send a meeting's spooled remote audio again; when lines land, unedited notes are written again and the
 * library is scheduled for indexing. Used by launch catch-up and the note's Retry button alike.
 */
export async function recoverMeetingTranscript(id: string, o: { retry?: boolean } | undefined, d: TranscriptFollowUp): Promise<void> {
  const before = d.segmentCount(id)
  await (d.recover ?? recoverTranscription)(id, o)
  if (d.segmentCount(id) <= before) return
  void d.applyTranscript(id, true)
  void d.scheduleIndex()
}
