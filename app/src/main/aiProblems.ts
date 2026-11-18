import type { AiProblemEvent, AiProblemUpdate } from '../shared/ai'

/** Latest transcription problem for each meeting and track. */
export class AiProblemState {
  private readonly problems = new Map<string, AiProblemEvent>()

  update(problem: AiProblemUpdate, at = Date.now()): AiProblemEvent | undefined {
    const event: AiProblemEvent = { ...problem, at }
    const key = `${problem.meetingId}\0${problem.track}`
    if (problem.code) this.problems.set(key, event)
    else this.problems.delete(key)
    return event
  }

  forMeeting(meetingId: string): AiProblemEvent | null {
    return [...this.problems.values()].filter(problem => problem.meetingId === meetingId).sort((a, b) => b.at - a.at)[0] ?? null
  }

  reset(meetingId: string): AiProblemEvent[] {
    const cleared: AiProblemEvent[] = []
    for (const [key, problem] of this.problems) {
      if (problem.meetingId !== meetingId) continue
      this.problems.delete(key)
      cleared.push({ code: null, meetingId, track: problem.track, at: Date.now() })
    }
    return cleared
  }
}
