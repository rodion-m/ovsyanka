import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiUsage } from '../../shared/ai'

export const OPENROUTER_USAGE_FILE = 'openrouter-usage.json'
export const OPENROUTER_USAGE_DAYS = 90

export type OpenRouterUsageTask = 'text' | 'transcription'
export type OpenRouterUsageEntry = {
  model: string
  task: OpenRouterUsageTask
  costUsd: number
  audioSeconds?: number
  /** OpenRouter reported zero cost for a non-free audio model; keep zero and mark it rather than estimating. */
  costUnknown?: boolean
  costMissing?: boolean
}

type ModelUsage = { textCostUsd: number; transcriptionCostUsd: number; audioSeconds: number; transcriptionCostUnknown: boolean; textCostUnknown: boolean }
type UsageDay = { costUsd: number; textCostUsd: number; transcriptionCostUsd: number; audioSeconds: number; transcriptionCostUnknown: boolean; textCostUnknown: boolean; missingCostCount: number; transcriptionMissingCostCount: number; textMissingCostCount: number; models: Record<string, ModelUsage> }
type UsageFile = { schema: 1; days: Record<string, UsageDay> }

function empty(): UsageFile { return { schema: 1, days: {} } }
export function openRouterLocalDateKey(at: number): string { const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

function usageDay(value: unknown): UsageDay {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const models: Record<string, ModelUsage> = {}
  if (raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
    for (const [id, value] of Object.entries(raw.models)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const model = value as Record<string, unknown>
      models[id] = {
        textCostUsd: finite(model.textCostUsd) ? model.textCostUsd : 0,
        transcriptionCostUsd: finite(model.transcriptionCostUsd) ? model.transcriptionCostUsd : 0,
        audioSeconds: finite(model.audioSeconds) ? model.audioSeconds : 0,
        transcriptionCostUnknown: model.transcriptionCostUnknown === true || model.costUnknown === true,
        textCostUnknown: model.textCostUnknown === true,
      }
    }
  }
  return {
    costUsd: finite(raw.costUsd) ? raw.costUsd : 0,
    textCostUsd: finite(raw.textCostUsd) ? raw.textCostUsd : 0,
    transcriptionCostUsd: finite(raw.transcriptionCostUsd) ? raw.transcriptionCostUsd : 0,
    audioSeconds: finite(raw.audioSeconds) ? raw.audioSeconds : 0,
    transcriptionCostUnknown: raw.transcriptionCostUnknown === true || raw.costUnknown === true,
    textCostUnknown: raw.textCostUnknown === true,
    missingCostCount: finite(raw.missingCostCount) ? raw.missingCostCount : 0,
    transcriptionMissingCostCount: finite(raw.transcriptionMissingCostCount) ? raw.transcriptionMissingCostCount : 0,
    textMissingCostCount: finite(raw.textMissingCostCount) ? raw.textMissingCostCount : 0,
    models,
  }
}

function parse(value: unknown): UsageFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty()
  const raw = value as Record<string, unknown>
  if (raw.schema !== 1 || !raw.days || typeof raw.days !== 'object' || Array.isArray(raw.days)) return empty()
  const days: Record<string, UsageDay> = {}
  for (const [date, day] of Object.entries(raw.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(date)) days[date] = usageDay(day)
  return { schema: 1, days }
}

function keepRecent(file: UsageFile, now: number): UsageFile {
  const cutoff = now - OPENROUTER_USAGE_DAYS * 24 * 60 * 60 * 1_000
  const days = Object.fromEntries(Object.entries(file.days).filter(([date]) => {
    const at = Date.parse(`${date}T00:00:00.000Z`)
    return Number.isFinite(at) && at >= cutoff
  }))
  return { schema: 1, days }
}

export class OpenRouterUsage {
  private readonly file: string
  private readonly now: () => number
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly options: { userData: string; now?: () => number }) {
    this.file = join(options.userData, OPENROUTER_USAGE_FILE)
    this.now = options.now ?? (() => Date.now())
  }

  private async read(): Promise<UsageFile> {
    try { return keepRecent(parse(JSON.parse(await readFile(this.file, 'utf8')) as unknown), this.now()) }
    catch { return empty() }
  }

  private async write(file: UsageFile): Promise<void> {
    await mkdir(this.options.userData, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.file)
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  async record(entry: OpenRouterUsageEntry): Promise<void> {
    if (!finite(entry.costUsd) || !finite(entry.audioSeconds ?? 0) || !entry.model) return
    const operation = this.writes.then(async () => {
      const now = this.now()
      const file = await this.read()
      const date = openRouterLocalDateKey(now)
      const day = file.days[date] ?? { costUsd: 0, textCostUsd: 0, transcriptionCostUsd: 0, audioSeconds: 0, transcriptionCostUnknown: false, textCostUnknown: false, missingCostCount: 0, transcriptionMissingCostCount: 0, textMissingCostCount: 0, models: {} }
      const model = day.models[entry.model] ?? { textCostUsd: 0, transcriptionCostUsd: 0, audioSeconds: 0, transcriptionCostUnknown: false, textCostUnknown: false }
      day.costUsd += entry.costUsd
      day.audioSeconds += entry.audioSeconds ?? 0
      if (entry.costUnknown) {
        if (entry.task === 'transcription') { day.transcriptionCostUnknown = true; model.transcriptionCostUnknown = true }
        else { day.textCostUnknown = true; model.textCostUnknown = true }
      }
      if (entry.costMissing) {
        day.missingCostCount++
        if (entry.task === 'transcription') { day.transcriptionMissingCostCount++; day.transcriptionCostUnknown = true; model.transcriptionCostUnknown = true }
        else { day.textMissingCostCount++; day.textCostUnknown = true; model.textCostUnknown = true }
      }
      if (entry.task === 'text') { day.textCostUsd += entry.costUsd; model.textCostUsd += entry.costUsd }
      else { day.transcriptionCostUsd += entry.costUsd; model.transcriptionCostUsd += entry.costUsd; model.audioSeconds += entry.audioSeconds ?? 0 }
      day.models[entry.model] = model
      file.days[date] = day
      await this.write(keepRecent(file, now))
    })
    this.writes = operation.catch(() => undefined)
    await operation
  }

  async summary(): Promise<AiUsage> {
    await this.writes
    const now = this.now()
    const today = openRouterLocalDateKey(now)
    const cutoff = now - 30 * 24 * 60 * 60 * 1_000
    const file = await this.read()
    let todayUsd = 0, thirtyDayUsd = 0
    const modelCost: Record<string, number> = {}, modelSeconds: Record<string, number> = {}
    let transcriptionCostUnknown = false, textCostUnknown = false, missingCostCount = 0
    const unknownModels = new Set<string>()
    for (const [date, day] of Object.entries(file.days)) {
      const at = Date.parse(`${date}T00:00:00.000Z`)
      if (date === today) todayUsd += day.costUsd
      if (Number.isFinite(at) && at >= cutoff) thirtyDayUsd += day.costUsd
      if (date === today) { transcriptionCostUnknown ||= day.transcriptionCostUnknown; textCostUnknown ||= day.textCostUnknown }
      missingCostCount += day.missingCostCount
      for (const [model, usage] of Object.entries(day.models)) {
        modelCost[model] = (modelCost[model] ?? 0) + usage.transcriptionCostUsd
        modelSeconds[model] = (modelSeconds[model] ?? 0) + usage.audioSeconds
        if (Number.isFinite(at) && at >= cutoff && usage.transcriptionCostUnknown) unknownModels.add(model)
      }
    }
    const transcriptionPerHourUsd: Record<string, number> = {}
    for (const model of Object.keys(modelCost)) {
      const seconds = modelSeconds[model] ?? 0
      if (seconds > 0) transcriptionPerHourUsd[model] = modelCost[model] / (seconds / 3_600)
    }
    for (const model of unknownModels) delete transcriptionPerHourUsd[model]
    return { todayUsd, thirtyDayUsd, transcriptionPerHourUsd, transcriptionCostUnknown, textCostUnknown, missingCostCount }
  }
}

export const createOpenRouterUsage = (options: { userData: string; now?: () => number }): OpenRouterUsage => new OpenRouterUsage(options)
