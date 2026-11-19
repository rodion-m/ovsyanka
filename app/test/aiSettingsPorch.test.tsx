// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { aiSettings } from '../src/shared/ai'
import { agyTextOptions, agyTranscriptionOptions, type AiOptions } from '../src/shared/aiCatalog'
import { setLanguage } from '../src/shared/i18n'
import { AiSettingsFields } from '../src/renderer/src/components/AiSettings'

const options: AiOptions = {
  transcription: [
    { id: 'agy-gemini', label: 'Audio profile', vendor: 'antigravity-cli', group: 'audio', hints: ['audio'], detail: 'antigravity-cli · gemini-4-hydrogen' },
    { id: 'agy-offline', label: 'Offline audio', vendor: 'antigravity-cli', group: 'unavailable', hints: ['audio', 'unavailable'], detail: 'antigravity-cli · gemini-3.8-flash', disabledReason: 'backend-unavailable' },
  ],
  text: [
    { id: 'agy-gemini', label: 'Audio profile', vendor: 'antigravity-cli', group: 'text', hints: [], detail: 'antigravity-cli · gemini-4-hydrogen' },
    { id: 'claude-opus', label: 'Claude Opus', vendor: 'claude-code', group: 'text', hints: [], detail: 'claude-code · opus' },
    { id: 'offline-text', label: 'Unavailable text', vendor: 'codex-cli', group: 'unavailable', hints: ['unavailable'], detail: 'codex-cli · gpt', disabledReason: 'backend-unavailable' },
  ], source: 'live',
}

function Stateful() {
  const [value, setValue] = useState(aiSettings({ backend: 'porch' }))
  return createElement(AiSettingsFields, { value, change: patch => setValue(previous => ({ ...previous, ...patch })) })
}

afterEach(() => { cleanup(); setLanguage('en'); Reflect.deleteProperty(window, 'yogurt') })

describe('Porch AI settings pickers', () => {
  it('limits transcription to capability profiles, disables unavailable profiles with a reason, and shows the profile model', async () => {
    Object.defineProperty(window, 'yogurt', { configurable: true, value: { ai: { options: vi.fn().mockResolvedValue(options) } } })
    const user = userEvent.setup()
    render(createElement(Stateful))
    const audio = await screen.findByTestId('ai-transcriptionProfile')
    await user.click(audio)
    expect(screen.getByRole('option', { name: /Audio profile/ })).not.toBeNull()
    expect(screen.getByRole('option', { name: /Offline audio/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('This profile’s CLI is not installed.')).not.toBeNull()
    expect(screen.queryByRole('option', { name: /Claude Opus/ })).toBeNull()
    await user.click(screen.getByRole('option', { name: /Audio profile/ }))
    expect(screen.getByTestId('ai-transcriptionProfile-sub').textContent).toContain('gemini-4-hydrogen')
    expect((screen.getByTestId('ai-transcriptionModel') as HTMLInputElement).value).toBe('gemini-4-hydrogen')
  })

  it('shows the list error while keeping the custom ID choice available', async () => {
    Object.defineProperty(window, 'yogurt', { configurable: true, value: { ai: { options: vi.fn().mockResolvedValue({ transcription: [], text: [], source: 'builtin', problem: 'unavailable' }) } } })
    const user = userEvent.setup()
    render(createElement(Stateful))
    const text = await screen.findByTestId('ai-textProfile')
    await waitFor(() => expect(screen.getByText('Could not load Porch profiles. You can still use a custom profile ID.')).not.toBeNull())
    expect(screen.getByTestId('ai-textProfile-sub').textContent).toContain('default')
    expect(screen.getByTestId('ai-textProfile-sub').textContent).not.toContain('custom ID')
    expect(screen.getByTestId('ai-transcriptionProfile-sub').textContent).toContain('default')
    expect(screen.getByTestId('ai-transcriptionProfile-sub').textContent).not.toContain('custom ID')
    await user.click(text)
    await user.keyboard('my-profile')
    expect(screen.getByRole('option', { name: /Use custom ID: "my-profile"/ })).not.toBeNull()
  })

  it('fetches agy models only when the picker refresh button is used', async () => {
    const refreshed: AiOptions = { transcription: agyTranscriptionOptions(), text: agyTextOptions(), source: 'live' }
    const request = vi.fn().mockResolvedValue(refreshed)
    Object.defineProperty(window, 'yogurt', { configurable: true, value: { ai: { options: request } } })
    const user = userEvent.setup()
    render(createElement(AiSettingsFields, { value: aiSettings({ backend: 'agy' }), change() {} }))
    expect(request).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('ai-textModel'))
    await user.click(screen.getByRole('button', { name: 'Refresh model list' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ backend: 'agy', refresh: true })))
  })
})
