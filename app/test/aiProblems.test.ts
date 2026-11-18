import { describe, expect, it } from 'vitest'
import { AiProblemState } from '../src/main/aiProblems'

describe('meeting and track transcription problems', () => {
  it('isolates meetings and clears only the successful track', () => {
    const state = new AiProblemState()
    state.update({ code: 'credits', meetingId: 'a', track: 'them' }, 10)
    state.update({ code: 'auth', meetingId: 'a', track: 'me' }, 20)
    state.update({ code: 'no-key', meetingId: 'b', track: 'them' }, 30)
    expect(state.forMeeting('a')).toMatchObject({ code: 'auth', track: 'me' })
    expect(state.forMeeting('b')).toMatchObject({ code: 'no-key', track: 'them' })
    state.update({ code: null, meetingId: 'a', track: 'them' }, 40)
    expect(state.forMeeting('a')).toMatchObject({ code: 'auth', track: 'me' })
    state.update({ code: null, meetingId: 'a', track: 'me' }, 50)
    expect(state.forMeeting('a')).toBeNull()
    expect(state.forMeeting('b')).toMatchObject({ code: 'no-key' })
  })

  it('resets only the meeting that starts a new recording', () => {
    const state = new AiProblemState()
    state.update({ code: 'credits', meetingId: 'a', track: 'them' }, 10)
    state.update({ code: 'auth', meetingId: 'b', track: 'me' }, 20)
    expect(state.reset('a')).toMatchObject([{ code: null, meetingId: 'a', track: 'them' }])
    expect(state.forMeeting('a')).toBeNull()
    expect(state.forMeeting('b')).toMatchObject({ code: 'auth' })
  })
})
