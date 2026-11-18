/**
 * The language people speak in meetings, picked in the note's footer or Settings → Language. Multi-language
 * (the default) lets transcription detect the language; English and Russian tell it which language to hear.
 * Independent of the interface language. Notes follow the meeting's language.
 */
export type Spoken = 'en' | 'ru' | 'multi'
export const SPOKEN: readonly Spoken[] = ['en', 'ru', 'multi']
export const spokenOf = (v: unknown): Spoken => (v === 'en' || v === 'ru' ? v : 'multi')
/** What Whisper is told for each chunk: a language code, or nothing (it detects and keeps each track's language). */
export const whisperLanguage = (s: Spoken): string | undefined => (s === 'multi' ? undefined : s)
/** how many languages whisper can hear (whisper.cpp's g_lang list less Cantonese, which large-v3 added) */
export const WHISPER_LANGUAGES = 99
