import { describe, expect, it } from 'vitest'
import { AiProblemState } from '../src/main/aiProblems'
import { AI_FAILURE_POLICY, AI_PROBLEM_CLASS, aiFailureClass, aiSpoolFailureAction } from '../src/shared/ai'

describe('the shared failure-class table', () => {
  it('classifies every AI problem and gives output failures one fresh response before a provider-specific spool action', () => {
    const codes = Object.keys(AI_PROBLEM_CLASS)
    expect(codes.length).toBeGreaterThan(0)
    expect(codes.every(code => AI_PROBLEM_CLASS[code as keyof typeof AI_PROBLEM_CLASS])).toBe(true)
    for (const code of ['bad-response', 'bad-timestamps', 'truncated'] as const) {
      expect(aiFailureClass(code)).toBe('output')
      expect(aiSpoolFailureAction(code, 'agy')).toBe('bump')
      expect(aiSpoolFailureAction(code, 'porch')).toBe('bump')
      expect(aiSpoolFailureAction(code, 'openrouter')).toBe('block')
    }
    expect(AI_FAILURE_POLICY.permanent.spool.openrouter).toBe('block')
    expect(aiFailureClass('no-timestamps')).toBe('permanent')
  })
})

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
