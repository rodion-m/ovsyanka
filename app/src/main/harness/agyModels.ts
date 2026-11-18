import { dirname } from 'node:path'
import { agyTextOptions, agyTranscriptionOptions, AGY_BUILTIN_MODELS, type AiOption, type AiOptions } from '../../shared/aiCatalog'
import { executablePath, HarnessError, HarnessProcesses, prependPath } from './process'

export type ParsedAgyModel = { id: string; label: string; effort?: string }

/** Parse the deliberately narrow tab-separated agy models output; unknown lines fail closed. */
export function parseAgyModels(output: string): ParsedAgyModel[] {
  const rows: ParsedAgyModel[] = []
  for (const line of output.split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (/^Fetching available models\.\.\.$/.test(value)) continue
    const match = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\t([^\t\r\n]+)$/)
    if (!match) throw new HarnessError('agy returned an unexpected model list. The built-in list is shown instead.')
    const level = match[1].match(/-(low|medium|high|xhigh|max)$/)
    if (!match[2].trim()) throw new HarnessError('agy returned an unexpected model list. The built-in list is shown instead.')
    rows.push({ id: level ? match[1].slice(0, -level[0].length) : match[1], label: match[2].trim().replace(/\s+\((?:Low|Medium|High|XHigh|Max)\)$/i, ''), ...(level ? { effort: level[1] } : {}) })
  }
  if (!rows.length) throw new HarnessError('agy returned an empty model list. The built-in list is shown instead.')
  return rows
}

export function mergeAgyModels(rows: readonly ParsedAgyModel[]): AiOption[] {
  const levels = new Map<string, Set<string>>()
  const names = new Map<string, string>()
  for (const row of rows) {
    const set = levels.get(row.id) ?? new Set<string>()
    if (row.effort) set.add(row.effort)
    levels.set(row.id, set)
    if (!names.has(row.id)) names.set(row.id, row.label)
  }
  const order = [...AGY_BUILTIN_MODELS]
  for (const id of levels.keys()) if (!order.some(option => option.id === id)) {
    order.push({ id, label: names.get(id)!, group: 'text', hints: [], efforts: [] })
  }
  return order.map(option => ({ ...option,
    efforts: (['low', 'medium', 'high'] as const).filter(level => (levels.get(option.id) ?? new Set(option.efforts ?? [])).has(level)),
    ...(levels.has(option.id) && names.get(option.id) ? { label: names.get(option.id)! } : {}),
  }))
}

const builtin = (): AiOptions => ({ transcription: agyTranscriptionOptions(), text: agyTextOptions(), source: 'builtin' })

/** Explicit-refresh only. Failures preserve the in-app catalog and report an actionable status. */
export async function loadAgyModels(o: { path?: string; refresh?: boolean; processes?: HarnessProcesses }): Promise<AiOptions> {
  if (!o.refresh) return builtin()
  const processes = o.processes ?? new HarnessProcesses()
  try {
    const binary = await executablePath(o.path ?? 'agy', 'Antigravity CLI (agy)')
    const env = { ...process.env }
    delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY; delete env.OPENROUTER_API_KEY
    delete env.YOGURT_OPENROUTER_API_KEY; delete env.AGY_ADC_AUTH
    const result = await processes.run({ label: 'agy model list', executable: binary, args: ['models'], env: prependPath(env, [dirname(binary)]), timeoutMs: 5000, stdoutLimit: 256 * 1024, stderrLimit: 32 * 1024 })
    const options = mergeAgyModels(parseAgyModels(result.stdout))
    return { transcription: options.filter(option => option.hints.includes('audio')), text: options.map(option => option.group === 'recommended' ? option : { ...option, group: 'text' }), source: 'live', fetchedAt: Date.now() }
  } catch {
    return { ...builtin(), problem: 'unavailable' }
  } finally { if (!o.processes) processes.stop() }
}
