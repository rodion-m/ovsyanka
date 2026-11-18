// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { aiSettings } from '../src/shared/ai'
import { agyTextOptions, validCustomId } from '../src/shared/aiCatalog'
import { setLanguage } from '../src/shared/i18n'
import { AiSettingsFields } from '../src/renderer/src/components/AiSettings'
import { ModelPicker, type ModelPickerGroup, type ModelPickerProps, type ModelPickerState } from '../src/renderer/src/components/ModelPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const groups: ModelPickerGroup[] = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'audio', label: 'Audio models' },
  { id: 'text', label: 'Text models' },
]

function Stateful({ initial = 'gemini-3.8-flash', options = agyTextOptions(), onChange = () => {}, ...props }: Partial<ModelPickerProps> & { initial?: string }) {
  const [value, setValue] = useState(initial)
  return createElement(ModelPicker, {
    id: 'ai-test', value, options, groups, allowCustom: true, validateCustom: validCustomId,
    onChange: (id: string) => { setValue(id); onChange(id) }, ...props,
  })
}

const setup = (props: Parameters<typeof Stateful>[0] = {}) => {
  const onChange = vi.fn()
  render(createElement(Stateful, { ...props, onChange }))
  const input = screen.getByRole('combobox') as HTMLInputElement
  const user = userEvent.setup()
  return { input, onChange, user }
}

const openWithState = async (state: ModelPickerState) => {
  const onRetry = vi.fn()
  const user = userEvent.setup()
  const withRetry: ModelPickerState = state.status === 'cache' || state.status === 'empty' || state.status === 'error' ? { ...state, onRetry } : state
  render(createElement(ModelPicker, { id: 'ai-s', value: 'x', options: agyTextOptions(), groups, allowCustom: true, validateCustom: validCustomId, onChange() {}, state: withRetry }))
  ;(screen.getByRole('combobox') as HTMLElement).focus()
  await user.keyboard('{ArrowDown}')
  return { user, onRetry }
}

afterEach(() => { cleanup(); setLanguage('en') })

describe('ModelPicker', () => {
  it('opens with ArrowDown, moves the highlight with arrows, and Enter commits it', async () => {
    const { input, onChange, user } = setup()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    input.focus()
    await user.keyboard('{ArrowDown}')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    // the selected model starts highlighted
    expect(input.getAttribute('aria-activedescendant')).toBe('ai-test-option-0')
    await user.keyboard('{ArrowDown}')
    expect(input.getAttribute('aria-activedescendant')).toBe('ai-test-option-1')
    await user.keyboard('{ArrowUp}')
    expect(input.getAttribute('aria-activedescendant')).toBe('ai-test-option-0')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('gemini-4-hydrogen')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.value).toBe('Gemini 4 Hydrogen')
  })

  it('selects an option with the mouse and shows its ID under the field', async () => {
    const { input, onChange, user } = setup()
    await user.click(input)
    await user.click(screen.getByRole('option', { name: /Claude Opus 5.5/ }))
    expect(onChange).toHaveBeenCalledWith('claude-opus-5-5')
    expect(input.value).toBe('Claude Opus 5.5')
    expect(screen.getByTestId('ai-test-sub').textContent).toContain('claude-opus-5-5')
  })

  it('Escape closes the list and restores the previous value after typing and highlighting', async () => {
    const { input, onChange, user } = setup()
    await user.click(input)
    await user.keyboard('argon')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Escape}')
    expect(onChange).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.value).toBe('Gemini 3.8 Flash')
  })

  it('Tab closes without a change so focus can move on', async () => {
    const { input, onChange, user } = setup()
    await user.click(input)
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Tab}')
    expect(onChange).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.value).toBe('Gemini 3.8 Flash')
  })

  it('filters by name, ID and vendor while typing, and the status announces the count', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('gemini-4')
    expect(screen.getByRole('status').textContent).toBe('2 found')
    // two matching models plus the always-last custom ID row
    expect(screen.getAllByRole('option')).toHaveLength(3)
    await user.keyboard(' hydrogen')
    expect(screen.getByRole('status').textContent).toBe('1 found')
    expect(screen.getByRole('option', { name: /Gemini 4 Hydrogen/ })).not.toBeNull()
  })

  it('offers the typed custom ID, selects it, and marks it as custom afterwards', async () => {
    const { input, onChange, user } = setup()
    await user.click(input)
    await user.keyboard('acme-9')
    const custom = screen.getByRole('option', { name: /Use custom ID: "acme-9"/ })
    expect(custom.textContent).toContain('custom ID')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('acme-9')
    expect(screen.getByTestId('ai-test-sub').textContent).toContain('acme-9')
    expect(screen.getByTestId('ai-test-sub').textContent).toContain('custom ID')
    // an exact listed ID gets no custom row
    await user.click(input)
    await user.keyboard('gemini-3.8-flash')
    expect(screen.queryByRole('option', { name: /Use custom ID/ })).toBeNull()
  })

  it('shows the allowed-characters note for an invalid custom ID and never selects it', async () => {
    const { onChange, user } = setup()
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('bad id!')
    expect(screen.queryByRole('option', { name: /Use custom ID/ })).toBeNull()
    expect(screen.getByText(/Latin letters, digits/)).not.toBeNull()
    await user.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('announces zero found and still keeps the custom ID row available', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('zzz')
    expect(screen.getByRole('status').textContent).toBe('0 found')
    expect(screen.getByText(/Nothing found/)).not.toBeNull()
    expect(screen.getByRole('option', { name: /Use custom ID: "zzz"/ })).not.toBeNull()
  })

  it('cannot be opened while locked', async () => {
    const { input, user } = setup({ locked: true })
    expect(input.disabled).toBe(true)
    await user.click(input)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows loading rows while the list is fetched', async () => {
    await openWithState({ status: 'loading' })
    expect(screen.getByText('Loading the list…')).not.toBeNull()
  })

  it('shows the offline notice with a retry for a cached list', async () => {
    const { user, onRetry } = await openWithState({ status: 'cache', fetchedAt: Date.parse('2026-11-12') })
    expect(screen.getByText(/No connection\. Showing the list from November 12/)).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows the unavailable message and still accepts a custom ID', async () => {
    const { user } = await openWithState({ status: 'empty' })
    expect(screen.getByText('The list is unavailable. Type a model ID instead.')).not.toBeNull()
    await user.keyboard('any-1')
    expect(screen.getByRole('option', { name: /Use custom ID: "any-1"/ })).not.toBeNull()
  })

  it('keeps built-in options visible beside a live-list error when requested', async () => {
    const user = userEvent.setup()
    render(createElement(ModelPicker, { id: 'ai-fallback', value: 'gemini-3.8-flash', options: agyTextOptions(), groups,
      allowCustom: true, validateCustom: validCustomId, onChange() {},
      state: { status: 'error', message: 'Could not get the list from agy. The built-in list is shown.', keepOptions: true } }))
    await user.click(screen.getByRole('combobox'))
    expect(screen.getByText('Could not get the list from agy. The built-in list is shown.')).not.toBeNull()
    expect(screen.getByRole('option', { name: /Claude Opus 5.5/ })).not.toBeNull()
  })
})

describe('agy model pickers in AI settings', () => {
  it('lists only audio-capable models for transcription and never offers low effort', async () => {
    const user = userEvent.setup()
    render(createElement(AiSettingsFields, { value: aiSettings({ backend: 'agy' }), change() {} }))
    const input = screen.getByTestId('ai-transcriptionModel') as HTMLInputElement
    expect(input.value).toBe('Gemini 3.8 Flash')
    await user.click(input)
    const names = screen.getAllByRole('option').map(option => option.textContent ?? '')
    expect(names.filter(name => name.includes('Gemini'))).toHaveLength(3)
    expect(names.some(name => name.includes('Claude'))).toBe(false)
    const levels = Array.from((screen.getByTestId('ai-transcriptionEffort') as HTMLElement).querySelectorAll('option')).map(option => option.getAttribute('value'))
    expect(levels).toEqual(['medium', 'high'])
    expect((screen.getByTestId('ai-textEffort') as HTMLSelectElement).value).toBe('medium')
  })

  it('narrows the text effort select to the picked model and drops an unsupported saved level', async () => {
    const change = vi.fn()
    const user = userEvent.setup()
    render(createElement(AiSettingsFields, { value: aiSettings({ backend: 'agy', textEffort: 'low' }), change }))
    await user.click(screen.getByTestId('ai-textModel'))
    await user.click(screen.getByRole('option', { name: /GPT-OSS 120B/ }))
    expect(change).toHaveBeenCalledWith({ textModel: 'gpt-oss-120b', textEffort: 'medium' })
  })

  it('accepts a custom model ID typed into the agy picker', async () => {
    const change = vi.fn()
    const user = userEvent.setup()
    render(createElement(AiSettingsFields, { value: aiSettings({ backend: 'agy' }), change }))
    await user.click(screen.getByTestId('ai-textModel'))
    await user.keyboard('claude-future-9')
    await user.keyboard('{Enter}')
    expect(change).toHaveBeenCalledWith({ textModel: 'claude-future-9' })
  })
})
