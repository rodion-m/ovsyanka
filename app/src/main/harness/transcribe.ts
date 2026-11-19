import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiSettings } from '../../shared/ai'
import { AI_PROBLEM_CLASS } from '../../shared/ai'
import type { Track } from '../capture'
import { languageCode, languageName } from '../asr/appleSpeech'
import { wavBytes, type Line, type Transcribe } from '../asr/transcribe'
import { packedToMeeting } from '../asr/batch'
import { isSilenceGuess } from '../asr/hallucination'
import { assertRunning, HarnessError, inStage, TranscriptOutputError, transcriptOutputFacts, transcriptOutputResponse, type TranscriptOutputFacts } from './process'
import { keepRejectedResponse } from './rejectedResponses'

const TRANSCRIPT_PROPERTIES = {
  language: { type: 'string' }, error: { type: 'string' },
  segments: { type: 'array', items: { type: 'object', properties: {
    start: { type: 'number' }, end: { type: 'number' }, speaker: { type: 'string' }, text: { type: 'string' },
  }, required: ['start', 'end', 'text'] } },
}

/** The native CLI historically requires only its authoritative segments field. */
export const TRANSCRIPT_SCHEMA: Record<string, unknown> = {
  type: 'object', properties: TRANSCRIPT_PROPERTIES, required: ['segments'],
}

/** OpenRouter strict structured outputs require every declared property. */
export const STRICT_TRANSCRIPT_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, properties: {
    language: TRANSCRIPT_PROPERTIES.language, error: TRANSCRIPT_PROPERTIES.error,
    segments: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' },
    }, required: ['start', 'end', 'text'] } },
  }, required: ['language', 'error', 'segments'],
}

/** Rules shared by the OpenRouter audio request and the CLI prompt. File/tool instructions stay CLI-only. */
export const TRANSCRIPTION_RULES = [
  'Each segment is a natural phrase or sentence, with start and end in seconds from the beginning of this file and verbatim text. Omit speaker labels.',
  'If you cannot hear the audio, return an empty segments array and a nonempty error. Return an empty array without error only for silence or no speech. Never guess.',
].join('\n')

type Transcript = { language?: string; segments: Array<{ start: number; end: number; text: string }> }
type TranscribeOptions = {
  prompt: () => string
  language: () => string | undefined
  onLanguage: (track: Track, language: string, chars: number, locked: boolean) => void
  rejectedDir?: string
}
export type AudioRequest = { directory: string; language?: string; clearMs?: number; instructions: string; prompt: string; maxOutputTokens?: number; signal: AbortSignal }

/** Audio requests get at least this long: a packed batch can take far longer than a text answer. */
export const MIN_AUDIO_TIMEOUT_SECONDS = 600

type JsonStatus = 'complete' | 'extracted' | 'truncated' | 'invalid'
type JsonObjectResult = { value?: unknown; status: JsonStatus }

/** Find a complete JSON object in a provider answer, skipping prose, fences and a UTF-8 BOM. */
function firstJsonObject(text: string): JsonObjectResult {
  try { return { value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown, status: 'complete' } } catch { /* extract below */ }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let work = 0
  let unclosed = false
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue
    if (++work > 32) return { status: 'invalid' }
    let depth = 0, quoted = false, escaped = false
    for (let at = start; at < source.length; at++) {
      if (++work > 2_000_000) return { status: 'invalid' }
      const c = source[at]
      if (quoted) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') quoted = false
        continue
      }
      if (c === '"') { quoted = true; continue }
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try { return { value: JSON.parse(source.slice(start, at + 1)) as unknown, status: 'extracted' } }
        catch { break }
      }
    }
    if (depth > 0) unclosed = true
  }
  return { status: unclosed ? 'truncated' : 'invalid' }
}

export type TranscriptParseDiagnostics = TranscriptOutputFacts & {
  jsonStatus: JsonStatus
  jsonCompleted: boolean
  responseLength: number
  segmentCount: number
  kept: number
  clamped: number
  dropped: number
  offendingIndex: number | null
  offendingStart: number | null
  offendingEnd: number | null
}

type DetailedTranscript = { transcript: Transcript; diagnostics: TranscriptParseDiagnostics }
type ParseOptions = { salvage?: boolean }

function outputError(text: string, code: 'bad-response' | 'bad-timestamps', message: string, facts: TranscriptParseDiagnostics): TranscriptOutputError {
  return new TranscriptOutputError(message, code, 0, undefined, text, facts)
}

/** Parse model output and retain only a bounded fraction of damaged segments after the fresh call. */
export function parseTranscriptDetailed(text: string, duration: number, options: ParseOptions = {}): DetailedTranscript {
  if (!Number.isFinite(duration) || duration < 0) throw new HarnessError('Invalid recording duration.')
  const extracted = firstJsonObject(text)
  const diagnostics: TranscriptParseDiagnostics = {
    jsonStatus: extracted.status, jsonCompleted: extracted.status === 'complete' || extracted.status === 'extracted',
    responseLength: text.length, segmentCount: 0, kept: 0, clamped: 0, dropped: 0,
    offendingIndex: null, offendingStart: null, offendingEnd: null,
  }
  const fail = (code: 'bad-response' | 'bad-timestamps', message: string): never => { throw outputError(text, code, message, { ...diagnostics }) }
  if (extracted.value === undefined) fail('bad-response', 'The remote AI did not return valid transcript JSON.')
  const value = extracted.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('bad-response', 'The remote AI returned an invalid transcript.')
  const object = value as Record<string, unknown>
  if (object.error != null && typeof object.error !== 'string') fail('bad-response', 'The remote AI returned an invalid transcript error field.')
  if (typeof object.error === 'string' && object.error.trim()) fail('bad-response', 'The remote AI could not listen to the recording.')
  if (object.language !== undefined && (typeof object.language !== 'string' || object.language.length > 80)) fail('bad-response', 'The remote AI returned an invalid transcript language.')
  const rawSegments = object.segments
  if (!Array.isArray(rawSegments) || rawSegments.length > 10_000) fail('bad-response', 'The remote AI returned an invalid transcript segment list.')
  const segmentsInput = rawSegments as unknown[]
  diagnostics.segmentCount = segmentsInput.length
  const segments: Transcript['segments'] = []
  const tolerance = Math.max(2, duration * 0.02)
  let timestampErrors = 0, textErrors = 0, totalTextChars = 0, droppedTextChars = 0, inversions = 0, previousStart: number | undefined
  const starts: Array<number | undefined> = []
  for (let index = 0; index < segmentsInput.length; index++) {
    const segment = segmentsInput[index]
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
      diagnostics.dropped++; textErrors++; starts.push(undefined)
      if (diagnostics.offendingIndex === null) diagnostics.offendingIndex = index
      continue
    }
    const { start, end, text: said } = segment as Record<string, unknown>
    const numericStart = typeof start === 'number' && Number.isFinite(start) ? start : undefined
    const numericEnd = typeof end === 'number' && Number.isFinite(end) ? end : undefined
    starts.push(numericStart)
    if (numericStart !== undefined && previousStart !== undefined && numericStart < previousStart) inversions++
    if (numericStart !== undefined) previousStart = numericStart
    const saidText = typeof said === 'string' ? said : ''
    totalTextChars += saidText.length
    if (typeof start !== 'number' || typeof end !== 'number' || numericStart === undefined || numericEnd === undefined
      || numericStart < -tolerance || numericEnd < numericStart || numericStart > duration + tolerance || numericEnd > duration + tolerance) {
      diagnostics.dropped++; timestampErrors++
      if (diagnostics.offendingIndex === null) {
        diagnostics.offendingIndex = index
        diagnostics.offendingStart = numericStart ?? null
        diagnostics.offendingEnd = numericEnd ?? null
      }
      droppedTextChars += saidText.length
      continue
    }
    if (typeof said !== 'string' || Buffer.byteLength(said, 'utf8') > 64 * 1024) {
      diagnostics.dropped++; textErrors++; droppedTextChars += saidText.length
      if (diagnostics.offendingIndex === null) { diagnostics.offendingIndex = index; diagnostics.offendingStart = numericStart; diagnostics.offendingEnd = numericEnd }
      continue
    }
    // models sometimes wrap quoted names in backslashes (\Имя\, \\Имя\\) or leave a lone \ between spaces;
    // they never belong in speech. Windows paths (C:\dir\file) keep theirs: only runs at word edges or between spaces go
    const clean = said
      .replace(/(^|[\s(\[\{"'«„“])\\+(?=\p{L})/gu, '$1')
      .replace(/(?<=\p{L})\\+(?=$|[\s)\]}"'»”’.,;:!?…])/gu, '')
      .replace(/(^|\s)\\+(?=\s|$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (!clean) {
      diagnostics.dropped++; textErrors++; droppedTextChars += said.length
      if (diagnostics.offendingIndex === null) { diagnostics.offendingIndex = index; diagnostics.offendingStart = numericStart; diagnostics.offendingEnd = numericEnd }
      continue
    }
    const clampedStart = Math.min(Math.max(numericStart, 0), duration)
    const clampedEnd = Math.min(Math.max(numericEnd, 0), duration)
    if (clampedStart !== numericStart || clampedEnd !== numericEnd) diagnostics.clamped++
    segments.push({ start: clampedStart, end: clampedEnd, text: clean })
  }
  diagnostics.kept = segments.length
  const maxDropped = Math.max(1, Math.floor(diagnostics.segmentCount * 0.1))
  const tailPast = starts.length >= 2 && starts.slice(-2).every(start => start !== undefined && start > duration)
  const denseOutput = segments.reduce((sum, segment) => sum + segment.text.length, 0) >= 200
    && duration > 0 && segments.reduce((sum, segment) => sum + segment.text.length, 0) / duration > 40
  const tooManyInversions = diagnostics.segmentCount > 0 && inversions / diagnostics.segmentCount > 0.1
  const tooManyDropped = diagnostics.dropped > maxDropped
  const tooMuchDroppedText = totalTextChars > 0 && droppedTextChars / totalTextChars > 0.1
  const globalTimelineError = tailPast || denseOutput || tooManyInversions || tooManyDropped || tooMuchDroppedText
  const firstAttemptDamaged = options.salvage === false && (diagnostics.dropped > 0 || diagnostics.clamped > 0)
  if ((diagnostics.dropped && !segments.length) || globalTimelineError || firstAttemptDamaged) {
    const code = timestampErrors ? 'bad-timestamps' : 'bad-response'
    fail(code, code === 'bad-timestamps' ? 'The remote AI returned timestamps outside the recording.' : 'The remote AI returned an invalid transcript segment.')
  }
  segments.sort((a, b) => a.start - b.start)
  return { transcript: { ...(typeof object.language === 'string' ? { language: object.language.trim() } : {}), segments }, diagnostics }
}

/** Parse structured transcript output without including response text in errors. */
export function parseTranscript(text: string, duration: number): Transcript {
  return parseTranscriptDetailed(text, duration, { salvage: true }).transcript
}

/**
 * Live probe on synthetic noise with no speech (9 requests): gemini-3.8-flash invented sentences from the vocabulary
 * line on 2 (15 s of clicks, 90 s of room tone), reporting SUCCESS; the same noise without the vocabulary line came
 * back empty. Audio is never skipped — the skip dropped real far-field speech — so a batch under this much clear
 * speech is sent without the vocabulary line instead.
 */
export const MIN_CLEAR_SPEECH_MS = 300

export function createHarnessTranscriber(o: { settings: AiSettings; tempDir: string; signal: AbortSignal; transcribe: (request: AudioRequest) => Promise<string> }, callbacks: TranscribeOptions): Transcribe {
  return async (chunk, options) => {
    const signal = options?.signal ? AbortSignal.any([o.signal, options.signal]) : o.signal
    // Speculative reads of every partial would multiply remote requests. Only completed VAD chunks are sent.
    if (options?.partial) return []
    assertRunning(signal)
    if (!Number.isFinite(chunk.startMs) || chunk.startMs < 0 || chunk.samples.length > 16_000 * 15 * 60) throw new HarnessError('Invalid or oversized recording chunk.')
    if (!chunk.samples.length) return []
    for (const sample of chunk.samples) if (!Number.isFinite(sample)) throw new HarnessError('The recording contains invalid audio samples.')
    const duration = chunk.samples.length / 16_000
    const rawLanguage = callbacks.language()?.trim()
    const language = rawLanguage && rawLanguage !== 'auto' ? rawLanguage : undefined
    if (language && (language.length > 80 || /[\0\r\n]/.test(language))) throw new HarnessError('Invalid transcription language.')
    const vocabulary = callbacks.prompt()
    if (Buffer.byteLength(vocabulary, 'utf8') > 16_384) throw new HarnessError('The transcription vocabulary is too large.')
    // almost no clear speech is the noise case where the model invents text from the vocabulary; the audio still goes
    const lowClear = chunk.clearMs !== undefined && chunk.clearMs < MIN_CLEAR_SPEECH_MS
    const instructions = [
      `The recording is exactly ${duration} seconds long. All timestamps must stay between 0 and ${duration} seconds.`,
      'Transcribe speech verbatim in its original language, including Russian. Do not translate. Preserve Russian spelling and punctuation.',
      ...(vocabulary && !lowClear ? [`Names and vocabulary (context only; never invent speech from them): ${vocabulary}`] : []),
    ].join('\n')
    const prompt = [
      'Transcribe the audio file ./audio.wav.',
      'Listen using your native file-reading tool (view_file / read_file). That tool supplies the actual audio to the model. Do not read waveform bytes as text, run commands, or infer speech from metadata.',
      'Work alone without subagents, web browsing, or other tools. Return only JSON matching the provided schema.',
      TRANSCRIPTION_RULES,
      ...(language ? [`Expected spoken language: ${language}.`] : []), instructions,
    ].join('\n')
    if (lowClear) console.log(`transcriber sending ${chunk.track} chunk at ${chunk.startMs} ms: ${duration.toFixed(1)} s of audio with ${chunk.clearMs} ms of clear speech, without the vocabulary line`)
    const maxOutputTokens = 48_000
    const batchId = randomUUID()
    const cli = o.settings.backend === 'porch' ? 'Porch' : o.settings.backend === 'agy' ? 'agy' : undefined
    const clearRatio = chunk.clearMs === undefined ? null : chunk.clearMs / (chunk.samples.length / 16)
    const logOutput = (status: 'rejected' | 'salvaged', attempt: number, raw: string | undefined, facts: Record<string, unknown>) => {
      const responseHash = raw === undefined ? null : createHash('sha256').update(raw).digest('hex').slice(0, 16)
      console.warn(`harness transcript ${status}`, {
        batchId, attempt, track: chunk.track, startMs: chunk.startMs, packedDurationMs: Math.round(chunk.samples.length / 16),
        partCount: chunk.parts?.length ?? 1, clearRatio, responseLength: raw?.length ?? facts.responseLength ?? 0,
        jsonCompleted: facts.jsonCompleted ?? false, jsonStatus: facts.jsonStatus ?? 'invalid',
        segmentCount: facts.segmentCount ?? 0, kept: facts.kept ?? 0, clamped: facts.clamped ?? 0, dropped: facts.dropped ?? 0,
        offendingIndex: facts.offendingIndex ?? null, offendingStart: facts.offendingStart ?? null, offendingEnd: facts.offendingEnd ?? null,
        responseHash,
      })
    }
    const rememberRejected = async (attempt: number, raw: string | undefined) => {
      if (raw === undefined || !callbacks.rejectedDir) return
      try { await keepRejectedResponse(callbacks.rejectedDir, `${batchId}-attempt-${attempt}`, raw) }
      catch (error) { console.warn('could not keep rejected transcript response', { batchId, attempt, error: error instanceof Error ? error.message : 'write failed' }) }
    }
    const asOutputError = (error: unknown, raw?: string): TranscriptOutputError | undefined => {
      if (error instanceof TranscriptOutputError) return error
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined
      if (typeof code !== 'string' || !(code in AI_PROBLEM_CLASS) || AI_PROBLEM_CLASS[code as keyof typeof AI_PROBLEM_CLASS] !== 'output') return
      const outputCode = code as 'bad-response' | 'bad-timestamps' | 'truncated'
      const message = error instanceof Error ? error.message : 'invalid transcript output'
      const errorCli = typeof error === 'object' && error !== null && 'cli' in error ? (error as { cli?: unknown }).cli : undefined
      return new TranscriptOutputError(message, outputCode, 0, errorCli === 'agy' || errorCli === 'Porch' ? errorCli : cli, raw)
    }
    let transcript: Transcript | undefined
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response: string | undefined
      try {
        // inStage allocates and removes a fresh directory for each output attempt.
        response = await inStage(o.tempDir, signal, async directory => {
          await writeFile(join(directory, 'audio.wav'), wavBytes(chunk.samples), { mode: 0o600 })
          assertRunning(signal)
          return o.transcribe({ directory, language, clearMs: chunk.clearMs, instructions, prompt, maxOutputTokens, signal })
        })
        assertRunning(signal)
        const parsed = parseTranscriptDetailed(response, duration, { salvage: attempt === 2 })
        if (!parsed.transcript.segments.length && (chunk.clearMs ?? 0) >= 20_000) {
          throw new TranscriptOutputError('The remote AI returned no speech despite substantial clear audio.', 'bad-response', attempt, cli, response,
            { ...parsed.diagnostics, clearMs: chunk.clearMs, emptyWithClearSpeech: true })
        }
        if (parsed.diagnostics.dropped || parsed.diagnostics.clamped) {
          logOutput('salvaged', attempt, response, parsed.diagnostics)
          await rememberRejected(attempt, response)
        }
        transcript = parsed.transcript
        break
      } catch (error) {
        assertRunning(signal)
        const output = asOutputError(error, response)
        if (!output) throw error
        const raw = transcriptOutputResponse(output) ?? response
        const facts = transcriptOutputFacts(output) ?? {}
        logOutput('rejected', attempt, raw, facts)
        await rememberRejected(attempt, raw)
        if (attempt === 2) throw new TranscriptOutputError(output.message, output.code, 2, output.cli ?? cli, raw, facts)
      }
    }
    if (!transcript) throw new HarnessError('Transcript output retry did not produce a result.')
    const reported = language ?? transcript.language
    const english = languageCode(reported) === 'en'
    const lines: Line[] = transcript.segments.map(segment => {
      const endMs = Math.round(packedToMeeting(chunk.parts, segment.end * 1000, 'end', chunk.startMs))
      // start and end map as a pair: inside one compressed pause the start snaps to the next part
      // and the end to the previous one, which would invert the line; pin it to the previous part's end
      const startMs = Math.min(Math.round(packedToMeeting(chunk.parts, segment.start * 1000, 'start', chunk.startMs)), endMs)
      return { track: chunk.track, startMs, endMs, text: segment.text }
    }).filter(line => !(lowClear && isSilenceGuess(line.text) && !(english && line.text.trim().replace(/[.!?…]+$/u, '').toLowerCase() === 'the')))
    const text = lines.map(line => line.text).join(' ')
    if (text && reported && reported.toLowerCase() !== 'auto') {
      const code = languageCode(reported)
      callbacks.onLanguage(chunk.track, code ? languageName(code) : reported.toLowerCase(), text.length, !!language)
    }
    return lines
  }
}
