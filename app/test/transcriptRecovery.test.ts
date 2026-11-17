import { describe, expect, it, vi } from 'vitest'
import { recoverMeetingTranscript } from '../src/main/transcriptRecovery'

describe('the follow-up after a meeting\'s spooled audio is sent again', () => {
  it('rewrites unedited notes and schedules indexing when segments were added', async () => {
    let count = 3
    const writeAgain = vi.fn(), scheduleIndex = vi.fn()
    const recover = vi.fn(async () => { count = 5 })
    await recoverMeetingTranscript('m1', undefined, {
      segmentCount: () => count, notesEdited: () => false, writeAgain, scheduleIndex, recover,
    })
    expect(recover).toHaveBeenCalledWith('m1', undefined)
    expect(writeAgain).toHaveBeenCalledWith('m1')
    expect(scheduleIndex).toHaveBeenCalled()
  })

  it('does nothing when recovery added no segments', async () => {
    const writeAgain = vi.fn(), scheduleIndex = vi.fn()
    await recoverMeetingTranscript('m1', { retry: true }, {
      segmentCount: () => 5, notesEdited: () => false, writeAgain, scheduleIndex,
      recover: async () => {},
    })
    expect(writeAgain).not.toHaveBeenCalled()
    expect(scheduleIndex).not.toHaveBeenCalled()
  })

  it('edited notes stand: indexing still runs, the rewrite does not', async () => {
    let count = 3
    const writeAgain = vi.fn(), scheduleIndex = vi.fn()
    await recoverMeetingTranscript('m1', undefined, {
      segmentCount: () => count, notesEdited: () => true, writeAgain, scheduleIndex,
      recover: async () => { count = 4 },
    })
    expect(writeAgain).not.toHaveBeenCalled()
    expect(scheduleIndex).toHaveBeenCalled()
  })
})
