import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AGY_BUILTIN_MODELS,
  type AiOption,
  agyTextOptions,
  agyTranscriptionOptions,
  estimateOpenRouterPricePerHour,
  isExpiringSoon,
  isModelMissing,
  missingModelIds,
  normalizeOpenRouterModel,
  normalizeOpenRouterResponse,
  searchAiOptions,
  selectTextOptions,
  selectTranscriptionOptions,
  sortAiOptions,
  validCustomId,
} from '../src/shared/aiCatalog'

type JsonBody = { data: unknown[] }

const textBody = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/openrouter/models-2026-11-18.json', import.meta.url)), 'utf8')) as JsonBody
const sttBody = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/openrouter/models-transcription-2026-11-18.json', import.meta.url)), 'utf8')) as JsonBody
const textModels = normalizeOpenRouterResponse(textBody)
const sttModels = normalizeOpenRouterResponse(sttBody)
const atNoonOnSnapshotDate = Date.parse('2026-11-18T12:00:00Z')

function rawModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    id: 'acme/meeting-model',
    name: 'Acme: Meeting Model',
    created: 1_700_000_000,
    architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text'] },
    endpoints: ['/api/v1/chat/completions'],
    pricing: { prompt: '0.000001', completion: '0.000002', audio: '0.000001' },
    context_length: 32_000,
    supported_parameters: ['structured_outputs'],
    reasoning: { supported_efforts: ['low', 'medium', 'high'] },
    expiration_date: null,
  }
  return {
    ...base,
    ...overrides,
    architecture: { ...base.architecture, ...(overrides.architecture as Record<string, unknown> | undefined) },
    pricing: { ...base.pricing, ...(overrides.pricing as Record<string, unknown> | undefined) },
  }
}

function model(id: string, records: readonly ReturnType<typeof normalizeOpenRouterModel>[]): NonNullable<ReturnType<typeof normalizeOpenRouterModel>> {
  const found = records.find(candidate => candidate?.id === id)
  expect(found, `fixture record ${id}`).toBeDefined()
  return found!
}

describe('OpenRouter catalog normalization and selection', () => {
  it('keeps the supported cache fields, trims values, and drops unknown fields', () => {
    const normalized = normalizeOpenRouterModel(rawModel({
      id: '  acme/custom  ', name: ' Acme: Custom ', description: 'do not cache', unknown: 'drop me',
      pricing: { prompt: ' 0.000001 ', completion: '0', overrides: [{ prompt: '9' }] },
    }))
    expect(normalized).toMatchObject({
      id: 'acme/custom', name: 'Acme: Custom', pricing: { prompt: '0.000001', completion: '0' },
    })
    expect(normalized).not.toHaveProperty('description')
    expect(normalized).not.toHaveProperty('unknown')
    expect(normalized?.pricing).not.toHaveProperty('overrides')
  })

  it('skips records that cannot be identified or classified', () => {
    expect(normalizeOpenRouterModel(rawModel({ id: undefined }))).toBeUndefined()
    const missingArchitecture = rawModel()
    delete missingArchitecture.architecture
    expect(normalizeOpenRouterModel(missingArchitecture)).toBeUndefined()
  })

  it.each([
    ['router price', rawModel({ id: 'acme/router', pricing: { prompt: '-1', completion: '-1' } }), false, false],
    ['router namespace', rawModel({ id: 'openrouter/auto', pricing: { prompt: '0', completion: '0' } }), false, false],
    ['batch endpoint/id', rawModel({ id: 'acme/meeting-model:batch', endpoints: ['/api/v1/batches'] }), false, false],
    ['floating alias', rawModel({ id: '~acme/meeting-model' }), false, false],
    ['expired model', rawModel({ expiration_date: '2026-11-17' }), false, false],
    ['audio without text output', rawModel({ architecture: { input_modalities: ['audio'], output_modalities: ['image'] } }), false, false],
    ['audio completion cap below a full batch', rawModel({ top_provider: { max_completion_tokens: 47_999 } }), false, true],
    ['audio completion cap for a full batch', rawModel({ top_provider: { max_completion_tokens: 48_000 } }), true, true],
    ['missing endpoints is treated as chat', rawModel({ endpoints: undefined }), true, true],
    ['missing created remains selectable', rawModel({ created: undefined }), true, true],
    ['free suffix and zero price', rawModel({ id: 'acme/meeting-model:free', pricing: { prompt: '0', completion: '0', audio: '0' } }), true, true],
    ['context just below minimum', rawModel({ architecture: { input_modalities: ['text'], output_modalities: ['text'] }, context_length: 31_999 }), false, false],
    ['context at minimum', rawModel({ architecture: { input_modalities: ['text'], output_modalities: ['text'] }, context_length: 32_000 }), false, true],
  ])('%s follows the hand-classified rule', (_name, raw, expectedAudio, expectedText) => {
    const normalized = normalizeOpenRouterModel(raw)
    expect(normalized).toBeDefined()
    const transcription = selectTranscriptionOptions([normalized!], [], { now: atNoonOnSnapshotDate })
    const text = selectTextOptions([normalized!], { now: atNoonOnSnapshotDate })
    expect(transcription.some(option => option.kind === 'chat')).toBe(expectedAudio)
    expect(text.some(option => option.id === normalized!.id)).toBe(expectedText)
  })

  it('places zero-priced records in the free group after the paid groups', () => {
    const normalized = normalizeOpenRouterModel(rawModel({ id: 'acme/meeting-model:free', pricing: { prompt: '0', completion: '0', audio: '0' } }))
    expect(normalized).toBeDefined()
    const options = selectTranscriptionOptions([normalized!], [], { now: atNoonOnSnapshotDate })
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ group: 'free', kind: 'chat' })
    expect(options[0].hints).toContain('free')
  })

  it('does not reject a record when optional fields are absent', () => {
    const normalized = normalizeOpenRouterModel(rawModel({
      created: undefined, endpoints: undefined, context_length: undefined,
      supported_parameters: undefined, reasoning: undefined, expiration_date: undefined,
      pricing: { prompt: 'not-a-number', completion: undefined, audio: undefined },
    }))
    expect(normalized).toBeDefined()
    const options = selectTranscriptionOptions([normalized!], [], { now: atNoonOnSnapshotDate })
    expect(options).toHaveLength(1)
    expect(options[0].addedAt).toBeUndefined()
    expect(options[0].price).toBeUndefined()
  })

  it('matches the hand-counted categories in both live snapshots', () => {
    expect(textModels).toHaveLength(478)
    expect(sttModels).toHaveLength(30)

    const transcription = selectTranscriptionOptions(textModels, sttModels, { now: atNoonOnSnapshotDate })
    const text = selectTextOptions(textModels, { now: atNoonOnSnapshotDate })
    expect(transcription).not.toHaveLength(0)
    expect(text).not.toHaveLength(0)

    // Selectable audio-chat counts exclude saved records with a known completion cap below 48k.
    const chatAudio = transcription.filter(option => option.kind === 'chat')
    expect(chatAudio).toHaveLength(28)
    expect(chatAudio.filter(option => !option.hints.includes('free'))).toHaveLength(27)
    expect(chatAudio.filter(option => option.hints.includes('free'))).toHaveLength(1)
    expect(transcription.filter(option => option.kind === 'stt')).toHaveLength(30)
    expect(transcription.filter(option => option.group === 'free')).toHaveLength(1)
    expect(transcription[0]?.id).toBe('google/gemini-3.8-flash')

    const paidText = text.filter(option => !option.hints.includes('free'))
    expect(paidText).toHaveLength(316)
    expect(text.filter(option => option.hints.includes('free'))).toHaveLength(14)
    expect(text[0]?.id).toBe('google/gemini-3.8-flash')

    expect(transcription.some(option => option.id.startsWith('openrouter/'))).toBe(false)
    expect(transcription.some(option => option.id.endsWith(':batch'))).toBe(false)
    expect(transcription.some(option => option.id.startsWith('~'))).toBe(false)
    expect(text.some(option => option.id.startsWith('openrouter/'))).toBe(false)
    expect(text.some(option => option.id.endsWith(':batch'))).toBe(false)
    expect(text.some(option => option.id.startsWith('~'))).toBe(false)
  })
})
describe('OpenRouter catalog prices and ordering', () => {
  it('uses the documented estimates and the bounded hourly window', () => {
    const gemini = model('google/gemini-3.8-flash', textModels)
    const whisper = model('openai/whisper-1', sttModels)
    const mai = model('microsoft/mai-transcribe-2', sttModels)
    // Completion usage includes reasoning: 11,986 tokens / 5 min; estimate is compared with fixture costs below.
    expect(estimateOpenRouterPricePerHour(gemini, 'chat')).toBeCloseTo(0.667, 2)
    expect(estimateOpenRouterPricePerHour(whisper, 'stt')).toBeCloseTo(0.36, 8)
    expect(estimateOpenRouterPricePerHour(mai, 'stt')).toBeUndefined()

    const transcription = selectTranscriptionOptions(textModels, sttModels, { now: atNoonOnSnapshotDate })
    const geminiOption = transcription.find(option => option.id === gemini.id)
    const whisperOption = transcription.find(option => option.id === whisper.id)
    expect(geminiOption).toBeDefined()
    expect(whisperOption).toBeDefined()
    expect(geminiOption?.price?.perHourUsd).toBeCloseTo(0.6675, 4)
    expect(geminiOption?.price?.estimated).toBe(true)
    expect(whisperOption?.price?.perHourUsd).toBeCloseTo(0.36, 8)
    expect(whisperOption?.price?.estimated).toBe(true)
  })

  it('keeps the hourly audio estimate within 30% of measured live fixture costs', () => {
    const gemini = model('google/gemini-3.8-flash', textModels)
    const estimate = estimateOpenRouterPricePerHour(gemini, 'chat')!
    for (const [file, seconds] of [['chat-60s.json', 60], ['chat-5m.json', 300]] as const) {
      const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/openrouter/live/${file}`, import.meta.url)), 'utf8')) as { usage: { cost: number } }
      const measuredPerHour = fixture.usage.cost * 3_600 / seconds
      expect(Math.abs(estimate - measuredPerHour) / measuredPerHour).toBeLessThanOrEqual(0.3)
    }
  })

  it('sorts equal dates and prices by ID, and puts missing values last', () => {
    const options: AiOption[] = [
      { id: 'z', label: 'z', group: 'text', hints: [], addedAt: 10, price: { inPerMillionUsd: 2 } },
      { id: 'a', label: 'a', group: 'text', hints: [], addedAt: 10, price: { inPerMillionUsd: 2 } },
      { id: 'm', label: 'm', group: 'text', hints: [], price: { inPerMillionUsd: 1 } },
      { id: 'n', label: 'n', group: 'text', hints: [] },
    ]
    expect(sortAiOptions(options, 'newest').map(option => option.id)).toEqual(['a', 'z', 'm', 'n'])
    expect(sortAiOptions(options, 'cheapest').map(option => option.id)).toEqual(['m', 'a', 'z', 'n'])
  })
})

describe('OpenRouter catalog lifecycle helpers', () => {
  it('marks only future expirations inside the 30-day window', () => {
    const now = Date.parse('2026-11-18T00:00:00Z')
    expect(isExpiringSoon('2026-12-17', now)).toBe(true)
    expect(isExpiringSoon('2026-12-19', now)).toBe(false)
    expect(isExpiringSoon('2026-11-17', now)).toBe(false)
    expect(isExpiringSoon(undefined, now)).toBe(false)
  })

  it('detects missing selected IDs without treating an empty options list as success', () => {
    const options: AiOption[] = [
      { id: 'google/gemini-3.8-flash', label: 'Gemini', group: 'recommended', hints: [] },
      { id: 'acme/kept', label: 'Kept', group: 'text', hints: [] },
    ]
    expect(options).not.toHaveLength(0)
    expect(isModelMissing('acme/gone', options)).toBe(true)
    expect(isModelMissing('acme/kept', options)).toBe(false)
    expect(missingModelIds(['acme/kept', 'acme/gone'], options)).toEqual(['acme/gone'])
  })
})

describe('agy built-in catalog', () => {
  it('mirrors the plan 3.3 table: transcription lists only audio-capable models, text lists them all', () => {
    expect(AGY_BUILTIN_MODELS.map(option => option.id)).toEqual([
      'gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-4-argon',
      'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b',
    ])
    const transcription = agyTranscriptionOptions()
    expect(transcription).not.toHaveLength(0)
    expect(transcription.every(option => option.hints.includes('audio'))).toBe(true)
    expect(transcription.map(option => option.id)).toEqual(['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-4-argon'])
    expect(transcription[0]?.group).toBe('recommended')
    expect(transcription[0]?.hints).toContain('verified')

    const text = agyTextOptions()
    expect(text).toHaveLength(AGY_BUILTIN_MODELS.length)
    expect(text[0]?.group).toBe('recommended')
    expect(text.filter(option => option.group !== 'recommended').every(option => option.group === 'text')).toBe(true)
    expect(text.find(option => option.id === 'gpt-oss-120b')?.efforts).toEqual(['medium'])
    expect(text.find(option => option.id === 'claude-opus-5-5')?.efforts).toEqual(['low', 'medium', 'high'])
  })

  it.each([
    ['one word of the name', 'opus', ['claude-opus-5-5']],
    ['several words, all must match', 'gemini flash', ['gemini-3.8-flash']],
    ['word order does not matter', 'flash gemini', ['gemini-3.8-flash']],
    ['part of the ID', 'gemini-4', ['gemini-4-hydrogen', 'gemini-4-argon']],
    ['the vendor', 'anthropic', ['claude-opus-5-5', 'claude-sonnet-5-5']],
    ['upper case is ignored', 'GPT-OSS', ['gpt-oss-120b']],
    ['a word only one model has', 'hydrogen', ['gemini-4-hydrogen']],
    ['words spanning name and ID', 'sonnet 5-5', ['claude-sonnet-5-5']],
    ['empty returns everything', '', AGY_BUILTIN_MODELS.map(option => option.id)],
    ['spaces only returns everything', '   ', AGY_BUILTIN_MODELS.map(option => option.id)],
    ['no match at all', 'zzz', []],
    ['one unmatched word drops the hit', 'gemini claude', []],
  ])('search: %s', (_name, query, expected) => {
    expect(searchAiOptions(AGY_BUILTIN_MODELS, query).map(option => option.id)).toEqual(expected)
  })

  it.each([
    ['a normal model ID', 'gemini-4-hydrogen', true],
    ['every boundary sign . - _ / :', 'a/b-c.d_e:f', true],
    ['an OpenRouter-style ID with free suffix', 'google/gemini-3.8-flash:free', true],
    ['digits and dots only between letters', 'v1.2.3', true],
    ['Cyrillic is rejected', 'модель', false],
    ['a space is rejected', 'has space', false],
    ['an empty ID is rejected', '', false],
    ['a tilde is rejected', '~alias/model', false],
    ['an at sign is rejected', 'model@2', false],
    ['a comma is rejected', 'a,b', false],
    ['exactly 200 characters pass', 'a'.repeat(200), true],
    ['201 characters fail', 'a'.repeat(201), false],
  ])('custom ID validation: %s', (_name, id, expected) => {
    expect(validCustomId(id)).toBe(expected)
  })
})
