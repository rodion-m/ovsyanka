import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiSettings } from '../../shared/ai'
import type { Track } from '../capture'
import { languageCode, languageName } from '../asr/appleSpeech'
import { wavBytes, type Line, type Transcribe } from '../asr/transcribe'
import { packedToMeeting } from '../asr/batch'
import { assertRunning, HarnessError, inStage } from './process'

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
}
export type AudioRequest = { directory: string; language?: string; instructions: string; prompt: string; maxOutputTokens?: number; signal: AbortSignal }

/** Audio requests get at least this long: a packed batch can take far longer than a text answer. */
export const MIN_AUDIO_TIMEOUT_SECONDS = 600

/** Find the first complete JSON object in a provider answer, skipping prose, fences and a UTF-8 BOM. */
function firstJsonObject(text: string): unknown | undefined {
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown } catch { /* extract below */ }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let work = 0
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue
    if (++work > 32) return undefined
    let depth = 0, quoted = false, escaped = false
    for (let at = start; at < source.length; at++) {
      if (++work > 2_000_000) return undefined
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
        try { return JSON.parse(source.slice(start, at + 1)) }
        catch { break }
      }
    }
  }
  return undefined
}

/** Parse the structured answer without including diagnostics or malformed provider text in an error. */
export function parseTranscript(text: string, duration: number): Transcript {
  if (!Number.isFinite(duration) || duration < 0) throw new HarnessError('Invalid recording duration.')
  const value = firstJsonObject(text)
  if (value === undefined) throw new HarnessError('The remote AI did not return valid transcript JSON.', 'bad-response', 0, undefined, true)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('The remote AI returned an invalid transcript.', 'bad-response', 0, undefined, true)
  const object = value as Record<string, unknown>
  if (object.error != null && typeof object.error !== 'string') throw new HarnessError('The remote AI returned an invalid transcript error field.', 'bad-response', 0, undefined, true)
  if (typeof object.error === 'string' && object.error.trim()) throw new HarnessError('The remote AI could not listen to the recording.', 'bad-response', 0, undefined, true)
  if (object.language !== undefined && (typeof object.language !== 'string' || object.language.length > 80)) throw new HarnessError('The remote AI returned an invalid transcript language.', 'bad-response', 0, undefined, true)
  if (!Array.isArray(object.segments) || object.segments.length > 10_000) throw new HarnessError('The remote AI returned an invalid transcript segment list.', 'bad-response', 0, undefined, true)
  const segments: Transcript['segments'] = []
  const tolerance = Math.max(2, duration * 0.02)
  for (const segment of object.segments) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) throw new HarnessError('The remote AI returned an invalid transcript segment.', 'bad-response', 0, undefined, true)
    const { start, end, text: said } = segment as Record<string, unknown>
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end < start || start > duration + tolerance || end > duration + tolerance) {
      throw new HarnessError('The remote AI returned timestamps outside the recording.', 'no-timestamps', 0, undefined, true)
    }
    if (typeof said !== 'string' || Buffer.byteLength(said, 'utf8') > 64 * 1024) throw new HarnessError('The remote AI returned invalid transcript text.', 'bad-response', 0, undefined, true)
    // models sometimes wrap quoted names in backslashes (\Имя\, \\Имя\\) or leave a lone \ between spaces;
    // they never belong in speech. Windows paths (C:\dir\file) keep theirs: only runs at word edges or between spaces go
    const clean = said
      .replace(/(^|[\s(\[\{"'«„“])\\+(?=\p{L})/gu, '$1')
      .replace(/(?<=\p{L})\\+(?=$|[\s)\]}"'»”’.,;:!?…])/gu, '')
      .replace(/(^|\s)\\+(?=\s|$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean) segments.push({ start: Math.min(start, duration), end: Math.min(end, duration), text: clean })
  }
  segments.sort((a, b) => a.start - b.start)
  return { ...(typeof object.language === 'string' ? { language: object.language.trim() } : {}), segments }
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
    // Speculative reads of every partial would multiply remote requests. Only completed VAD chunks are sent.
    if (options?.partial) return []
    assertRunning(o.signal)
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
    const response = await inStage(o.tempDir, o.signal, async directory => {
      await writeFile(join(directory, 'audio.wav'), wavBytes(chunk.samples), { mode: 0o600 })
      assertRunning(o.signal)
      return o.transcribe({ directory, language, instructions, prompt, maxOutputTokens, signal: o.signal })
    })
    assertRunning(o.signal)
    let transcript: Transcript
    try { transcript = parseTranscript(response, duration) }
    catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid transcript'
      console.warn(`harness transcript rejected: ${response.length} characters; ${reason}`)
      throw error
    }
    const lines: Line[] = transcript.segments.map(segment => {
      const endMs = Math.round(packedToMeeting(chunk.parts, segment.end * 1000, 'end', chunk.startMs))
      // start and end map as a pair: inside one compressed pause the start snaps to the next part
      // and the end to the previous one, which would invert the line; pin it to the previous part's end
      const startMs = Math.min(Math.round(packedToMeeting(chunk.parts, segment.start * 1000, 'start', chunk.startMs)), endMs)
      return { track: chunk.track, startMs, endMs, text: segment.text }
    })
    const text = lines.map(line => line.text).join(' ')
    const reported = language ?? transcript.language
    if (text && reported && reported.toLowerCase() !== 'auto') {
      const code = languageCode(reported)
      callbacks.onLanguage(chunk.track, code ? languageName(code) : reported.toLowerCase(), text.length, !!language)
    }
    return lines
  }
}
