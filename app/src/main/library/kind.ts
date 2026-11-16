import type { Filters } from './filters'

/**
 * What a question across meetings wants, by simple rules (swappable for something smarter later):
 * - find: where or what someone said: the best chunks of transcript;
 * - across: something gathered over many meetings (to-dos, decisions, a recap): each matching meeting's notes,
 *   which already sum it up.
 */
export type Kind = 'find' | 'across'

const GATHER = /\b(?:action items?|to-?dos?|tasks|next steps|follow[- ]?ups?|decisions?|takeaways?)\b/i
const ALL = /\b(?:all|every|each|across|any)\b/i
const MINE = /\b(?:my|our)\s+(?:open\s+)?(?:action items?|to-?dos?|tasks|next steps|follow[- ]?ups?)\b/i
const DECIDED = /\bwhat\s+(?:did|have|has)\s+(?:we|they|i|the team)\s+(?:decide|decided|agree|agreed)\b/i
const RECAP = /\b(?:summari[sz]e|sum up|recap|overview|catch me up|what happened)\b/i

// JavaScript's \b does not recognize Cyrillic word boundaries. Keep these rules to common requests for a list or recap.
const russian = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, 'iu')
const TASKS_RU = russian('задачи|поручения|дела|следующие\\s+шаги|дальнейшие\\s+шаги')
const MINE_RU = russian('мои|наши|у\\s+(?:меня|нас)')
const GATHER_RU = russian('задачи|поручения|следующие\\s+шаги|дальнейшие\\s+шаги|решения|договор[её]нности|выводы')
const ALL_RU = russian('все|всех|каждой|каждого|каждую')
const DECIDED_RU = russian('что\\s+(?:(?:мы|они|я|команда)\\s+)?(?:решили|решила|решил|решено)|о\\s+ч[её]м\\s+(?:(?:мы|они|я|команда)\\s+)?(?:договорились|договорилась|договорился)|какие\\s+решения\\s+(?:(?:мы|они|команда)\\s+)?(?:приняли|приняла|принял)')
const RECAP_RU = russian('итоги|обзор|сводка|сводку|резюме|что\\s+произошло')
const MEETINGS_RU = russian('встреч|встречи|встречах|встречам|совещаний|совещания|совещаниях|собраний|собрания|собраниях')

export function questionKind(question: string, f: Filters): Kind {
  const dated = f.from !== undefined
  if (MINE.test(question) || DECIDED.test(question)) return 'across'
  if (GATHER.test(question) && (ALL.test(question) || dated)) return 'across'
  if (RECAP.test(question) && (dated || /\bmeetings\b/i.test(question))) return 'across'
  if ((TASKS_RU.test(question) && MINE_RU.test(question)) || DECIDED_RU.test(question)) return 'across'
  if (GATHER_RU.test(question) && (ALL_RU.test(question) || dated)) return 'across'
  if (RECAP_RU.test(question) && (dated || MEETINGS_RU.test(question))) return 'across'
  return 'find'
}
