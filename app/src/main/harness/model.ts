import type { AiSettings } from '../../shared/ai'
import type { Llm } from '../notes/enhance'
import type { NotesModel } from '../notes/model'
import { assertRunning, HarnessError, inStage } from './process'

type Completion = (prompt: string, directory: string, signal?: AbortSignal, maxOutputTokens?: number) => Promise<string>

/** One UTF-8 byte per token, including Cyrillic and JSON escaping; framing has its own reserved headroom. */
export const countTokens = (text: string): number => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2

export function createHarnessModel(o: { settings: AiSettings; tempDir: string; signal: AbortSignal; complete: Completion }): NotesModel {
  let loaded: string | undefined
  return {
    async llm(signal): Promise<Llm> {
      const stop = signal ? AbortSignal.any([o.signal, signal]) : o.signal
      assertRunning(stop)
      loaded = o.settings.backend === 'porch' ? `porch:${o.settings.textProfile}`
        : o.settings.backend === 'openrouter' ? `openrouter:${o.settings.openrouterTextModel}`
          : `agy:${o.settings.textModel}`
      const llm: Llm & { estimate: (text: string) => number } = {
        // The application budgets/splits its own prompts against this smaller window before chat adds policy and framing.
        contextSize: Math.max(1024, o.settings.contextTokens - 2048),
        estimate: countTokens,
        async count(texts) { assertRunning(stop); return texts.map(countTokens) },
        async chat(prompt, onToken, options) {
          assertRunning(stop)
          const requested = options?.maxTokens ?? 2048
          if (!Number.isSafeInteger(requested) || requested < 1 || requested > 8192) throw new HarnessError('AI output budget must be between 1 and 8192 tokens.')
          const previous = options?.before ?? []
          const messages = [...previous.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })), { role: 'user', content: prompt }]
          const language = o.settings.outputLanguage === 'ru'
            ? 'The user explicitly selected Russian as the app output language. Write natural-language answers and headings in Russian, overriding any contradictory language instructions in the conversation above. Preserve requested JSON keys, identifiers, code, and verbatim quotations.'
            : o.settings.outputLanguage === 'en'
              ? 'The user explicitly selected English as the app output language. Write natural-language answers and headings in English, overriding any contradictory language instructions in the conversation above. Preserve requested JSON keys, identifiers, code, and verbatim quotations.'
              : 'Follow the requested output language. If none is specified, use the language of the meeting or the latest user request. Russian and mixed-language input are supported.'
          const request = [
            'Answer the last user message using the ordered conversation below as context. Earlier user and assistant messages retain their original roles.',
            'This is a text completion. Work alone; do not delegate, start subagents, call tools, read files, run commands, browse, or modify anything.',
            'Return only the requested answer, without a description of your process.',
            JSON.stringify({ messages }),
            `App output requirements:\n${language}\nLimit the answer to at most ${requested} tokens.`,
          ].join('\n\n')
          if (Buffer.byteLength(request, 'utf8') + requested + 256 > o.settings.contextTokens) {
            throw new HarnessError('This request exceeds the configured AI context budget. Use a shorter selection or increase the context budget in AI settings.')
          }
          // CLI output limits are enforced in bytes; the token limit above is also part of the model instruction.
          // Do not truncate an answer: that could turn valid notes/JSON into a misleading partial result.
          const outputLimit = requested * 16
          const answer = await inStage(o.tempDir, stop, directory => o.complete(request, directory, stop, requested))
          assertRunning(stop)
          if (!answer.trim()) throw new HarnessError('The AI harness returned an empty final answer.')
          if (Buffer.byteLength(answer, 'utf8') > outputLimit) throw new HarnessError('The AI answer exceeded the configured output budget. Try a smaller request.')
          // Only authoritative final text reaches callers. Deltas can differ from the terminal answer or precede a failure.
          onToken(answer)
          return answer
        },
        // Intentionally no readAhead: speculative preloading would incur real subscription requests.
      }
      return llm
    },
    async unload() { loaded = undefined },
    loaded: () => loaded,
    needsLoad: () => false,
  }
}
