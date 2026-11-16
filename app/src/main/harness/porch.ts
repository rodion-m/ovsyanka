import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AiSettings } from '../../shared/ai'
import { assertRunning, executablePath, HarnessError, HarnessProcesses } from './process'
import { TRANSCRIPT_SCHEMA } from './transcribe'

/** Internal (not public semver) adapter contract audited against CodeAlive-AI/pragmatic-orchestration. */
export const PORCH_CONTRACT = 'b0c5cf4d5d236677595a508ee3491d56ae1e0e8a'

export function exactProfile(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new HarnessError('Choose one exact Porch profile ID using letters, numbers, dots, underscores, or hyphens. Lists and wildcards are not supported.')
  }
  return value
}

export async function porchInstallation(path: string): Promise<{ porch: string; runner: string; bash: string }> {
  if (process.platform === 'win32') {
    throw new HarnessError('Porch integration currently requires macOS or Linux with Bash and Python 3. On Windows, choose the native agy executable instead.')
  }
  const porch = await executablePath(path, 'Porch')
  const runner = join(dirname(porch), 'lib', 'backend_run.sh')
  try {
    const file = await stat(runner)
    if (!file.isFile() || file.size > 2 * 1024 * 1024) throw new Error('not a supported adapter')
    await access(runner, constants.R_OK)
    const source = await readFile(runner, 'utf8')
    if (!source.includes('--raw|--no-wrap)') || !source.includes('MODE_CAP_SHELL')
      || !source.includes('build_cmd_agy') || !source.includes('PORCH_OUTPUT_SCHEMA')) throw new Error('unsupported interface')
  } catch {
    throw new HarnessError(`Porch's internal raw adapter was not found beside its real executable. Install the complete pragmatic-orchestration package compatible with ${PORCH_CONTRACT.slice(0, 7)}, then select scripts/porch.`)
  }
  return { porch, runner, bash: await executablePath('bash', 'Bash') }
}

function environment(directory: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['PORCH_DUMP_ARGV', 'PORCH_DEBUG_EVENTS', 'PORCH_DEBUG_EVENTS_PATH', 'PORCH_ARTIFACT_KEY', 'PORCH_RAW_PROMPT', 'PORCH_SKIP_OUTPUT_TEMPLATE', 'PORCH_OUTPUT_SCHEMA', 'PORCH_MEDIA_IMAGES']) delete env[key]
  return { ...env, TMPDIR: directory, TMP: directory, TEMP: directory,
    PORCH_PROGRESS: 'none', PORCH_PROGRESS_STYLE: 'none', PORCH_SAVE_OUTPUTS: '0',
    PORCH_RUN_DIR: join(directory, 'run'), PORCH_OUTPUT_DIR: join(directory, 'outputs'), PORCH_SINGLE_AGENT: '1' }
}

/**
 * One trusted, configured profile. Porch retains its provider's permissions and authentication.
 * Select subscription-account profiles: arbitrary profiles can instead be configured for API billing.
 * This adapter is not a universal tool sandbox and does not invoke review-ask or delegate modes.
 */
export function createPorch(settings: AiSettings, processes: HarnessProcesses) {
  let resolved: ReturnType<typeof porchInstallation> | undefined
  const installation = () => (resolved ??= porchInstallation(settings.porchPath).catch(error => { resolved = undefined; throw error }))
  let audioProfile: Promise<void> | undefined
  const requireAudioProfile = (directory: string, signal?: AbortSignal) => (audioProfile ??= (async () => {
    const profile = exactProfile(settings.transcriptionProfile)
    const { porch, bash } = await installation()
    // Public, read-only JSON configuration query: no provider or model is started. At the pinned
    // contract only antigravity-cli declares transcribe; names alone never establish native audio support.
    const result = await processes.run({ label: 'Porch audio capabilities', executable: bash,
      args: [porch, 'media', 'capabilities', '--json'], cwd: directory, env: environment(directory),
      signal, timeoutMs: 5000, stdoutLimit: 128 * 1024 })
    let capabilities: unknown
    try { capabilities = JSON.parse(result.stdout) } catch { throw new HarnessError('Porch did not return valid media capabilities. Install the supported pragmatic-orchestration package.') }
    if (!capabilities || typeof capabilities !== 'object' || !('transcribe' in capabilities)
      || !Array.isArray(capabilities.transcribe) || !capabilities.transcribe.every(value => typeof value === 'string')) {
      throw new HarnessError('Porch did not return valid audio profile capabilities. Install the supported pragmatic-orchestration package.')
    }
    if (!capabilities.transcribe.includes(profile)) {
      throw new HarnessError('The selected Porch transcription profile does not support native audio. Choose one exact antigravity-cli profile listed by porch media capabilities --json.')
    }
  })().catch(error => { audioProfile = undefined; throw error }))
  return {
    async text(prompt: string, directory: string, signal?: AbortSignal): Promise<string> {
      const profile = exactProfile(settings.textProfile)
      const { runner, bash } = await installation()
      assertRunning(signal)
      const file = join(directory, 'prompt.txt')
      await writeFile(file, prompt, { encoding: 'utf8', mode: 0o600 })
      // review ask adds an advisory template; delegate is unrestricted. Neither is an application completion API.
      // No model override: the selected profile chooses the text harness, model and effort.
      const result = await processes.run({ label: 'Porch', executable: bash,
        args: [runner, '--mode', 'media', '--agent-id', profile, '--raw', '--prompt-file', file],
        cwd: directory, env: environment(directory), signal, timeoutMs: settings.timeoutSeconds * 1000,
        stdoutLimit: 2 * 1024 * 1024 })
      if (!result.stdout.trim()) throw new HarnessError('Porch returned an empty final response.')
      return result.stdout
    },
    async transcribe(prompt: string, directory: string, signal?: AbortSignal): Promise<string> {
      const profile = exactProfile(settings.transcriptionProfile)
      await requireAudioProfile(directory, signal)
      const { runner, bash } = await installation()
      const agy = await executablePath(settings.agyPath, 'Antigravity CLI (agy)')
      assertRunning(signal)
      const file = join(directory, 'prompt.txt'), schema = join(directory, 'schema.json')
      await writeFile(file, prompt, { encoding: 'utf8', mode: 0o600 })
      await writeFile(schema, JSON.stringify(TRANSCRIPT_SCHEMA), { encoding: 'utf8', mode: 0o600 })
      // Keep the staged WAV and its exact clock. Public media transcribe re-encodes it to MP3 and
      // clamps provider timestamps, which would hide invalid results from Yogurt's strict parser.
      const result = await processes.run({ label: 'Porch transcription', executable: bash,
        args: [runner, '--mode', 'media', '--agent-id', profile, '--raw', '--prompt-file', file], cwd: directory,
        env: { ...environment(directory), PORCH_BIN_AGY: agy, AGY_MODEL: settings.transcriptionModel,
          AGY_EFFORT: settings.transcriptionEffort, PORCH_OUTPUT_SCHEMA: schema },
        signal, timeoutMs: settings.timeoutSeconds * 1000, stdoutLimit: 2 * 1024 * 1024 })
      if (!result.stdout.trim()) throw new HarnessError('Porch transcription returned an empty response.')
      return result.stdout
    },
  }
}
