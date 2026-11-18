// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { aiSettings, type AiProblemEvent, type AiSettings as Configuration } from '../src/shared/ai'
import type { AiOptions } from '../src/shared/aiCatalog'
import { setLanguage } from '../src/shared/i18n'
import { AiSettings, AiSettingsFields } from '../src/renderer/src/components/AiSettings'

const key = `sk-or-v1-${'a'.repeat(64)}`
const options: AiOptions = {
  source: 'live', fetchedAt: Date.now(),
  transcription: [
    { id: 'google/gemini-3.8-flash', label: 'Gemini Flash', group: 'recommended', kind: 'chat', hints: ['audio'], price: { perHourUsd: 0.2 }, addedAt: 1_800_000_000 },
    { id: 'acme/whisper-1', label: 'Whisper', group: 'stt', kind: 'stt', hints: ['tokens'] },
  ],
  text: [
    { id: 'google/gemini-3.8-flash', label: 'Gemini Flash', group: 'recommended', hints: [] },
    { id: 'acme/text', label: 'Text Model', group: 'text', hints: [], price: { inPerMillionUsd: 1, outPerMillionUsd: 2 } },
  ],
}
const openrouter = {
  keyStatus: vi.fn().mockResolvedValue({ state: 'none' }),
  setKey: vi.fn().mockResolvedValue({ state: 'ok', source: 'keychain', last4: 'aaaa', label: 'test key', remainingUsd: 2 }),
  clearKey: vi.fn().mockResolvedValue({ state: 'none' }),
  checkKey: vi.fn().mockResolvedValue({ state: 'ok', source: 'keychain', last4: 'aaaa' }),
  probe: vi.fn().mockResolvedValue({ ok: true, elapsedMs: 1200, message: 'OK', costUsd: 0.0001 }),
  usage: vi.fn().mockResolvedValue({ todayUsd: 0.2, thirtyDayUsd: 1, transcriptionPerHourUsd: {}, transcriptionCostUnknown: false, textCostUnknown: false, missingCostCount: 0 }),
}
const api = { ai: {
  options: vi.fn().mockResolvedValue(options), openrouter,
  get: vi.fn().mockResolvedValue({ saved: aiSettings({ backend: 'openrouter' }), active: aiSettings({ backend: 'openrouter' }), restartRequired: false }),
  save: vi.fn(), check: vi.fn(), restart: vi.fn(),
  onProblem: vi.fn<(cb: (problem: AiProblemEvent) => void) => () => void>(),
} }
let problemListener: ((problem: AiProblemEvent) => void) | undefined
function Stateful({ initial = aiSettings({ backend: 'openrouter' }) }: { initial?: Configuration }) {
  const [value, setValue] = useState(initial)
  const [updates, setUpdates] = useState<string[]>([])
  return createElement('div', { 'data-updates': updates.join('|') }, createElement(AiSettingsFields, { value, change: patch => { setValue(previous => ({ ...previous, ...patch })); setUpdates(previous => [...previous, ...Object.values(patch).map(String)]) } }))
}
afterEach(() => { cleanup(); setLanguage('en'); Reflect.deleteProperty(window, 'yogurt'); vi.clearAllMocks(); problemListener = undefined })
function installApi(catalog = options) {
  api.ai.options.mockResolvedValue(catalog)
  Object.defineProperty(window, 'yogurt', { configurable: true, value: api })
}

describe('OpenRouter AI settings', () => {
  it('clears a pasted key before submitting it and only renders its masked status', async () => {
    installApi()
    const user = userEvent.setup()
    const { container } = render(createElement(Stateful))
    const input = await screen.findByTestId('ai-openrouter-key')
    await user.click(input)
    await user.paste(key)
    await waitFor(() => expect(openrouter.setKey).toHaveBeenCalledWith(key))
    expect(container.innerHTML).not.toContain(key)
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).not.toBe(key)
    expect(screen.getByText(/Key works/)).not.toBeNull()
  })

  it('offers replace and remove for a saved key, and shows the configured key check', async () => {
    installApi()
    openrouter.keyStatus.mockResolvedValueOnce({ state: 'ok', source: 'keychain', last4: 'beef' })
    const user = userEvent.setup()
    render(createElement(Stateful))
    await screen.findByRole('button', { name: 'Replace' })
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    expect(screen.getByTestId('ai-openrouter-key')).not.toBeNull()
    await user.click(screen.getByTestId('ai-openrouter-key'))
    await user.paste(`sk-or-v1-${'b'.repeat(64)}`)
    await waitFor(() => expect(openrouter.setKey).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(openrouter.clearKey).toHaveBeenCalled())
  })

  it('rejects a key from another service and keeps it out of React-visible output', async () => {
    installApi()
    openrouter.setKey.mockResolvedValueOnce({ state: 'rejected', source: 'keychain', last4: 'fake', problem: 'auth' })
    const user = userEvent.setup()
    const { container } = render(createElement(Stateful))
    const input = await screen.findByTestId('ai-openrouter-key')
    await user.click(input)
    await user.paste('sk-ant-not-an-openrouter-key')
    await waitFor(() => expect(screen.getByText(/OpenRouter rejected this key/)).not.toBeNull())
    expect(container.innerHTML).not.toContain('sk-ant-not-an-openrouter-key')
    expect(container.firstElementChild?.getAttribute('data-updates')).not.toContain('sk-ant-not-an-openrouter-key')
  })

  it('marks STT as experimental, leaves it visible but disabled, and disables the same-model option', async () => {
    installApi()
    const user = userEvent.setup()
    render(createElement(Stateful, { initial: aiSettings({ backend: 'openrouter', openrouterTranscriptionModel: 'acme/whisper-1', openrouterTranscriptionKind: 'stt' }) }))
    const picker = await screen.findByTestId('ai-openrouter-transcriptionModel')
    await user.click(picker)
    const stt = screen.getByRole('option', { name: /Whisper/ })
    expect(stt.getAttribute('aria-disabled')).toBe('true')
    expect(stt.textContent).toContain('experimental')
    expect(stt.textContent).toContain('May invent text on noise without speech')
    const chatAudio = screen.getByRole('option', { name: /Gemini Flash/ })
    expect(chatAudio.textContent).toContain('experimental')
    expect(chatAudio.textContent).toContain('May invent text on noise without speech')
    expect(screen.getByLabelText('Same model for summaries and questions').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('This model only transcribes. Choose another one for text.')).not.toBeNull()
    await user.click(screen.getByTestId('ai-openrouter-textModel'))
    expect(screen.getByRole('option', { name: /Text Model/ }).textContent).not.toContain('experimental')
  })

  it('turns off the derived same-model state by choosing a separate text model', async () => {
    installApi()
    const user = userEvent.setup()
    render(createElement(Stateful))
    const checkbox = await screen.findByLabelText('Same model for summaries and questions') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    await user.click(checkbox)
    expect(checkbox.checked).toBe(false)
  })

  it('shows cached options offline, sort controls, refresh, and missing-model status', async () => {
    installApi({ ...options, source: 'cache', problem: 'network', fetchedAt: Date.now() - 60_000 })
    const user = userEvent.setup()
    render(createElement(Stateful, { initial: aiSettings({ backend: 'openrouter', openrouterTextModel: 'old/vendor' }) }))
    const text = await screen.findByTestId('ai-openrouter-textModel')
    expect(screen.getByTestId('ai-openrouter-textModel-sub').textContent).toContain('old/vendor')
    await user.click(text)
    expect(screen.getByText(/No connection. Showing the list/)).not.toBeNull()
    const cheapest = screen.getByRole('button', { name: 'Cheapest' })
    cheapest.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Cheapest' }).getAttribute('aria-pressed')).toBe('true')
    const refresh = screen.getByRole('button', { name: 'Refresh list' })
    refresh.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(api.ai.options).toHaveBeenCalledWith(expect.objectContaining({ backend: 'openrouter', refresh: true })))
  })

  it('marks a selected model missing from a fresh OpenRouter list', async () => {
    installApi()
    render(createElement(Stateful, { initial: aiSettings({ backend: 'openrouter', openrouterTextModel: 'old/vendor' }) }))
    await screen.findByTestId('ai-openrouter-textModel')
    expect(screen.getByText('The model "old/vendor" is no longer on OpenRouter. Choose another in Settings. Your audio is kept.')).not.toBeNull()
  })

  it('shows the data policy default and localized experimental copy in Russian', async () => {
    installApi()
    setLanguage('ru')
    const user = userEvent.setup()
    render(createElement(Stateful))
    expect((await screen.findByTestId('ai-openrouter-dataPolicy') as HTMLSelectElement).value).toBe('deny')
    await user.click(screen.getByTestId('ai-openrouter-transcriptionModel'))
    expect(screen.getAllByText('экспериментальная').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Может выдумывать текст на шуме без речи').length).toBeGreaterThan(0)
  })

  it('runs the text and bundled-audio probes and reports time and OpenRouter cost', async () => {
    installApi()
    openrouter.keyStatus.mockResolvedValueOnce({ state: 'ok', source: 'keychain', last4: 'aaaa' })
    const user = userEvent.setup()
    render(createElement(Stateful))
    await screen.findByRole('button', { name: 'Replace' })
    const tests = screen.getAllByRole('button', { name: 'Test' })
    await user.click(tests[0])
    await waitFor(() => expect(openrouter.probe).toHaveBeenCalledWith(expect.objectContaining({ backend: 'openrouter' }), 'transcription'))
    await user.click(screen.getAllByRole('button', { name: 'Test' })[1])
    await waitFor(() => expect(openrouter.probe).toHaveBeenCalledWith(expect.objectContaining({ backend: 'openrouter' }), 'text'))
    expect(screen.getAllByText(/Test passed · 1.2s · \$0.0001/).length).toBe(2)
  })

  it('shows credits, auth and missing-model problems in settings, then clears them', async () => {
    installApi()
    api.ai.onProblem.mockImplementation(cb => { problemListener = cb; return () => { problemListener = undefined } })
    render(createElement(AiSettings))
    await screen.findByTestId('ai-settings')
    await waitFor(() => expect(problemListener).toBeDefined())
    for (const [code, text] of [['credits', 'credits have run out'], ['auth', 'rejected the key'], ['model-gone', 'is unavailable']] as const) {
      act(() => problemListener?.({ code, meetingId: 'meeting-1', track: 'me', model: 'acme/model', at: Date.now() }))
      expect(screen.getByTestId('ai-openrouter-problem').textContent).toContain(text)
    }
    act(() => problemListener?.({ code: null, meetingId: 'meeting-1', track: 'me', at: Date.now() }))
    expect(screen.queryByTestId('ai-openrouter-problem')).toBeNull()
  })
})
