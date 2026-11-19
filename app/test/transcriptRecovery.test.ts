import { describe, expect, it, vi } from 'vitest'
import { recoverMeetingTranscript } from '../src/main/transcriptRecovery'

describe('the follow-up after a meeting\'s spooled audio is sent again', () => {
  it('rewrites unedited notes and schedules indexing when segments were added', async () => {
    let count = 3
    const applyTranscript = vi.fn(), scheduleIndex = vi.fn()
    const recover = vi.fn(async () => { count = 5 })
    await recoverMeetingTranscript('m1', undefined, {
      segmentCount: () => count, applyTranscript, scheduleIndex, recover,
    })
    expect(recover).toHaveBeenCalledWith('m1', undefined)
    expect(applyTranscript).toHaveBeenCalledWith('m1', true)
    expect(scheduleIndex).toHaveBeenCalled()
  })

  it('does nothing when recovery added no segments', async () => {
    const applyTranscript = vi.fn(), scheduleIndex = vi.fn()
    await recoverMeetingTranscript('m1', { retry: true }, {
      segmentCount: () => 5, applyTranscript, scheduleIndex,
      recover: async () => {},
    })
    expect(applyTranscript).not.toHaveBeenCalled()
    expect(scheduleIndex).not.toHaveBeenCalled()
  })

  it('delegates edit protection to notes while still scheduling indexing', async () => {
    let count = 3
    const applyTranscript = vi.fn(), scheduleIndex = vi.fn()
    await recoverMeetingTranscript('m1', undefined, {
      segmentCount: () => count, applyTranscript, scheduleIndex,
      recover: async () => { count = 4 },
    })
    expect(applyTranscript).toHaveBeenCalledWith('m1', true)
    expect(scheduleIndex).toHaveBeenCalled()
  })
})
