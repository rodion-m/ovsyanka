import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { Note } from '../src/renderer/src/screens/Note'
import { RecordingHint } from '../src/renderer/src/components/RecordingHint'
import type { AiProblemEvent } from '../src/shared/ai'
import type { MeetingView, NoteView } from '../src/shared/types'

// Run the note's effects and handlers without mounting editors, a browser, or capture.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[],
  memos: [] as unknown[], effects: [] as { deps?: unknown[]; run: () => void | (() => void); cleanup?: () => void; pending: boolean }[],
  state: 0, ref: 0, memo: 0, effect: 0 }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.state++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === 'function' ? next(hooks.values[i]) : next }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ?? (hooks.refs[hooks.ref - 1] = { current: initial }),
  useMemo: (make: () => unknown) => { const i = hooks.memo++; return hooks.memos[i] ?? (hooks.memos[i] = make()) },
  useLayoutEffect: () => {},
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => {
    const i = hooks.effect++, prev = hooks.effects[i]
    hooks.effects[i] = { run, deps, cleanup: prev?.cleanup, pending: !prev || !deps || deps.some((dep, index) => dep !== prev.deps?.[index]) }
  },
}))
vi.mock('../src/renderer/src/motion', async original => ({ ...await original<typeof import('../src/renderer/src/motion')>(), useReducedMotion: () => true }))
let meeting: MeetingView, notes: NoteView
let meetingChanged: () => void, notesChanged: (notes: NoteView) => void
let aiProblemChanged: (problem: AiProblemEvent) => void
const retryTranscription = vi.fn()
const title = vi.fn(), source = vi.fn()
let tree: ReactNode
const unmount = () => { hooks.effects.forEach(effect => effect.cleanup?.()); hooks.values = []; hooks.refs = []; hooks.memos = []; hooks.effects = [] }
async function render() {
  hooks.state = 0; hooks.ref = 0; hooks.memo = 0; hooks.effect = 0
  tree = Note({ id: 'pending-fixture', onTitleChange: title, onSource: source })
  for (const effect of hooks.effects) if (effect.pending) {
    effect.cleanup?.()
    effect.cleanup = effect.run() || undefined
    effect.pending = false
  }
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
function find(node: ReactNode, id: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, id)).find(Boolean)
  if (!isValidElement<Record<string, unknown>>(node)) return
  return node.props['data-testid'] === id || node.props.testId === id ? node : find(node.props.children as ReactNode, id)
}
function findComponent<P>(node: ReactNode, component: (props: P) => ReactNode): ReactElement<P> | undefined {
  if (Array.isArray(node)) return node.map(child => findComponent(child, component)).find(Boolean)
  if (!isValidElement<P>(node)) return
  const props = node.props as P & { children?: ReactNode }
  return node.type === component ? node : findComponent(props.children, component)
}
beforeEach(() => {
  vi.clearAllMocks()
  meeting = { id: 'pending-fixture', title: 'Pending fixture', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'stopped', language: null, titleSource: 'user', transcriptionPending: true, transcriptIncomplete: true }
  notes = { meetingId: meeting.id, mine: '', enhanced: null, edited: false, status: 'done', draft: '', peopleChanged: false }
  retryTranscription.mockResolvedValue(undefined)
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), yogurt: {
    meetings: { get: async () => meeting, onChange: (cb: typeof meetingChanged) => { meetingChanged = cb; return vi.fn() }, retryTranscription },
    notes: { get: async () => notes, onChange: (cb: typeof notesChanged) => { notesChanged = cb; return vi.fn() } },
    ai: { get: async () => ({ active: { backend: 'agy' } }), problemState: async () => null, onProblem: (cb: typeof aiProblemChanged) => { aiProblemChanged = cb; return vi.fn() } },
    widget: { state: async () => null, onState: () => vi.fn() },
  } })
})
afterEach(() => { unmount(); vi.unstubAllGlobals() })

it('shows the incomplete-transcript banner on a pending stopped meeting and Retry asks for recovery', async () => {
  await render(); await render()
  expect(find(tree, 'note-transcript-pending')).toBeDefined()
  ;(find(tree, 'note-transcript-retry')!.props.onClick as () => void)()
  await render()
  expect(retryTranscription).toHaveBeenCalledExactlyOnceWith(meeting.id)
})

it('hides the banner once nothing is really waiting, while recording, and in the Trash', async () => {
  // the raw pending flag alone never shows it: the computed field decides
  meeting = { ...meeting, transcriptIncomplete: false }
  await render(); await render()
  expect(find(tree, 'note-transcript-pending')).toBeUndefined()
  meeting = { ...meeting, transcriptIncomplete: true, state: 'recording', endedAt: null }
  await render(); await render()
  expect(find(tree, 'note-transcript-pending')).toBeUndefined()
  meeting = { ...meeting, state: 'stopped', endedAt: 2, trashedAt: 3 }
  await render(); await render()
  expect(find(tree, 'note-transcript-pending')).toBeUndefined()
})

it('shows only transcription problems for this meeting', async () => {
  await render()
  aiProblemChanged({ code: 'credits', meetingId: 'another-meeting', track: 'them', model: 'vendor/model', at: 10 })
  await render()
  expect(findComponent(tree, RecordingHint)).toBeUndefined()

  aiProblemChanged({ code: 'credits', meetingId: meeting.id, track: 'them', model: 'vendor/model', at: 20 })
  await render()
  expect(findComponent(tree, RecordingHint)?.props.hint.aiProblem).toMatchObject({ meetingId: meeting.id, track: 'them', code: 'credits' })
})
