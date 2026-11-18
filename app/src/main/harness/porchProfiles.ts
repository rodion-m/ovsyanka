import { tmpdir } from 'node:os'
import { inStage, HarnessError, HarnessProcesses, prependPath } from './process'
import { exactProfile, porchInstallation, porchEnvironment, porchChildPathDirs, readPorchCapabilities } from './porch'
import type { AiOption, AiOptions } from '../../shared/aiCatalog'

export type PorchProfile = { id: string; label: string; backend: string; model: string; enabled?: string; backendAvailable: boolean }

function decodeXml(value: string): string {
  return value.replace(/&(quot|apos|lt|gt|amp);/g, (_, entity: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[entity]!))
}

export function parsePorchProfiles(output: string): PorchProfile[] {
  const profiles: PorchProfile[] = []
  for (const match of output.matchAll(/<agent\b([^>]*)\/?\s*>/g)) {
    const attrs: Record<string, string> = {}
    const source = match[1]
    const attr = /([A-Za-z][A-Za-z0-9-]*)\s*=\s*(["'])(.*?)\2/g
    let parsed = '', item: RegExpExecArray | null
    while ((item = attr.exec(source))) {
      if (source.slice(parsed.length, item.index).trim()) throw new HarnessError('Porch returned malformed profile attributes.')
      parsed = source.slice(0, attr.lastIndex)
      attrs[item[1]] = decodeXml(item[3])
    }
    if (source.slice(parsed.length).replace(/\/\s*$/, '').trim()) throw new HarnessError('Porch returned malformed profile attributes.')
    if (!attrs.id) continue
    try { exactProfile(attrs.id) } catch { continue }
    if (!attrs.label || !attrs.backend || !attrs.model) throw new HarnessError('Porch returned a profile without its label, backend, or model.')
    profiles.push({ id: attrs.id, label: attrs.label, backend: attrs.backend, model: attrs.model,
      ...(attrs.enabled === undefined ? {} : { enabled: attrs.enabled }), backendAvailable: attrs['backend-available'] !== 'false' })
  }
  if (!profiles.length) throw new HarnessError('Porch returned no usable profiles.')
  return profiles
}

function option(profile: PorchProfile, transcription = false): AiOption {
  const unavailable = !profile.backendAvailable
  return { id: profile.id, label: profile.label, vendor: profile.backend,
    group: unavailable ? 'unavailable' : transcription ? 'audio' : 'text',
    hints: [ ...(transcription ? ['audio' as const] : []), ...(unavailable ? ['unavailable' as const] : []) ],
    detail: `${profile.backend} · ${profile.model}`,
    ...(unavailable ? { disabledReason: 'backend-unavailable' } : {}) }
}

export function buildPorchOptions(profiles: readonly PorchProfile[], transcribe: readonly string[]): AiOptions {
  const transcribeIds = new Set(transcribe)
  return {
    transcription: profiles.filter(profile => transcribeIds.has(profile.id)).map(profile => option(profile, true)),
    text: profiles.map(profile => option(profile)), source: 'live', fetchedAt: Date.now(),
  }
}

const cache = new Map<string, AiOptions>()
const failure = (): AiOptions => ({ transcription: [], text: [], source: 'builtin', problem: 'unavailable' })

export async function loadPorchProfiles(o: { porchPath?: string; agyPath?: string; refresh?: boolean; processes?: HarnessProcesses }): Promise<AiOptions> {
  const porchPath = o.porchPath ?? 'porch', agyPath = o.agyPath ?? 'agy', key = `${porchPath}\0${agyPath}`
  if (!o.refresh && cache.has(key)) return { ...cache.get(key)!, source: 'cache' }
  const processes = o.processes ?? new HarnessProcesses()
  try {
    const installation = await porchInstallation(porchPath)
    const pathDirs = await porchChildPathDirs(agyPath)
    const results = await inStage(tmpdir(), undefined, async directory => {
      const list = await processes.run({ label: 'Porch profiles', executable: installation.bash,
        args: [installation.porch, '--list-agents'], cwd: directory,
        env: prependPath(porchEnvironment(directory), pathDirs), timeoutMs: 5000, stdoutLimit: 256 * 1024 })
      const profiles = parsePorchProfiles(list.stdout)
      const transcribe = await readPorchCapabilities({ porch: installation.porch, bash: installation.bash,
        directory, processes, pathDirs })
      return { profiles, transcribe }
    })
    const value = buildPorchOptions(results.profiles, results.transcribe)
    cache.set(key, value)
    return value
  } catch { return failure() }
  finally { if (!o.processes) processes.stop() }
}

export function clearPorchProfileCache(): void { cache.clear() }
