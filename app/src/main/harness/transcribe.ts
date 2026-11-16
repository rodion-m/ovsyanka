import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiSettings } from '../../shared/ai'
import type { Track } from '../capture'
import { languageCode, languageName } from '../asr/appleSpeech'
import { wavBytes, type Line, type Transcribe } from '../asr/transcribe'
import { packedToMeeting } from '../asr/batch'
import { assertRunning, HarnessError, inStage } from './process'

export const TRANSCRIPT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    language: { type: 'string' }, error: { type: 'string' },
    segments: { type: 'array', items: { type: 'object', properties: {
      start: { type: 'number' }, end: { type: 'number' }, speaker: { type: 'string' }, text: { type: 'string' },
    }, required: ['start', 'end', 'text'] } },
  },
  required: ['segments'],
}

type Transcript = { language?: string; segments: Array<{ start: number; end: number; text: string }> }
type TranscribeOptions = {
  prompt: () => string
  language: () => string | undefined
  onLanguage: (track: Track, language: string, chars: number, locked: boolean) => void
}
export type AudioRequest = { directory: string; language?: string; instructions: string; prompt: string; signal: AbortSignal }

/** Audio requests get at least this long: a packed batch can take far longer than a text answer. */
export const MIN_AUDIO_TIMEOUT_SECONDS = 600

/** Parse only the structured terminal answer. Never include diagnostics or malformed provider text in an error. */
export function parseTranscript(text: string, duration: number): Transcript {
  if (!Number.isFinite(duration) || duration < 0) throw new HarnessError('Invalid recording duration.')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new HarnessError('The AI harness did not return valid transcript JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('The AI harness returned an invalid transcript.')
  const object = value as Record<string, unknown>
  if (object.error !== undefined && typeof object.error !== 'string') throw new HarnessError('The AI harness returned an invalid transcript error field.')
  if (typeof object.error === 'string' && object.error.trim()) throw new HarnessError('The AI harness could not listen to the recording. Check native audio support and file-read permissions in the CLI.')
  if (object.language !== undefined && (typeof object.language !== 'string' || object.language.length > 80)) throw new HarnessError('The AI harness returned an invalid transcript language.')
  if (!Array.isArray(object.segments) || object.segments.length > 10_000) throw new HarnessError('The AI harness returned an invalid transcript segment list.')
  const segments: Transcript['segments'] = []
  let previousStart = 0
  for (const segment of object.segments) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) throw new HarnessError('The AI harness returned an invalid transcript segment.')
    const { start, end, text: said } = segment as Record<string, unknown>
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end < start || start < previousStart || start > duration + 0.001 || end > duration + 0.001) {
      throw new HarnessError('The AI harness returned transcript timestamps outside the recording.')
    }
    previousStart = start
    if (typeof said !== 'string' || Buffer.byteLength(said, 'utf8') > 64 * 1024) throw new HarnessError('The AI harness returned invalid transcript text.')
    const clean = said.replace(/\s+/g, ' ').trim()
    if (clean) segments.push({ start: Math.min(start, duration), end: Math.min(end, duration), text: clean })
  }
  return { ...(typeof object.language === 'string' ? { language: object.language.trim() } : {}), segments }
}

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
    const instructions = [
      `The recording is exactly ${duration} seconds long. All timestamps must stay between 0 and ${duration} seconds.`,
      'Transcribe speech verbatim in its original language, including Russian. Do not translate. Preserve Russian spelling and punctuation.',
      ...(vocabulary ? [`Names and vocabulary (context only; never invent speech from them): ${vocabulary}`] : []),
    ].join('\n')
    const prompt = [
      'Transcribe the audio file ./audio.wav.',
      'Listen using your native file-reading tool (view_file / read_file). That tool supplies the actual audio to the model. Do not read waveform bytes as text, run commands, or infer speech from metadata.',
      'Work alone without subagents, web browsing, or other tools. Return only JSON matching the provided schema.',
      'Each segment is a natural phrase or sentence, with start and end in seconds from the beginning of this file and verbatim text. Omit speaker labels.',
      'If you cannot hear the audio, return an empty segments array and a nonempty error. Return an empty array without error only for silence or no speech. Never guess.',
      ...(language ? [`Expected spoken language: ${language}.`] : []), instructions,
    ].join('\n')
    const response = await inStage(o.tempDir, o.signal, async directory => {
      await writeFile(join(directory, 'audio.wav'), wavBytes(chunk.samples), { mode: 0o600 })
      assertRunning(o.signal)
      return o.transcribe({ directory, language, instructions, prompt, signal: o.signal })
    })
    assertRunning(o.signal)
    const transcript = parseTranscript(response, duration)
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
