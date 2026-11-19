import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { clampTranscriptionEffort, type AiSettings } from '../../shared/ai'
import { assertRunning, executablePath, HarnessError, HarnessProcesses, prependPath } from './process'
import { MIN_AUDIO_TIMEOUT_SECONDS, TRANSCRIPT_SCHEMA } from './transcribe'

/** Internal (not public semver) adapter contract audited against CodeAlive-AI/pragmatic-orchestration. */
export const PORCH_CONTRACT = 'b0c5cf4d5d236677595a508ee3491d56ae1e0e8a'

export function exactProfile(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new HarnessError('Choose one exact Porch profile ID using letters, numbers, dots, underscores, or hyphens. Lists and wildcards are not supported.', 'cli-config', 0, undefined, true, 'Porch')
  }
  return value
}

export async function porchInstallation(path: string): Promise<{ porch: string; runner: string; bash: string }> {
  if (process.platform === 'win32') {
    throw new HarnessError('Porch integration currently requires macOS or Linux with Bash and Python 3. On Windows, choose the native agy executable instead.', 'cli-config', 0, undefined, true, 'Porch')
  }
  const porch = await executablePath(path, 'Porch')
  const runner = join(dirname(porch), 'lib', 'backend_run.sh')
  try {
    const file = await stat(runner)
    if (!file.isFile() || file.size > 2 * 1024 * 1024) throw new Error('not a supported adapter')
    await access(runner, constants.R_OK)
    const source = await readFile(runner, 'utf8')
    if (!source.includes('--raw|--no-wrap)') || !source.includes('MODE_CAP_SHELL')
      || !source.includes('build_cmd_agy') || !source.includes('PORCH_OUTPUT_SCHEMA')
      || !source.includes('PORCH_BIN_AGY')) throw new Error('unsupported interface')
  } catch {
    throw new HarnessError(`Porch's internal raw adapter was not found beside its real executable. Install the complete pragmatic-orchestration package compatible with ${PORCH_CONTRACT.slice(0, 7)}, then select scripts/porch.`, 'cli-missing', 0, undefined, true, 'Porch')
  }
  return { porch, runner, bash: await executablePath('bash', 'Bash') }
}

// The Porch route is subscription-account only: provider API credentials never reach a child.
const PORCH_PROVIDER_CREDENTIALS = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY',
  'OPENROUTER_API_KEY', 'YOGURT_OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
]
// An inherited binary, model or effort override would silently repoint a profile at another CLI or settings.
const PORCH_INHERITED_OVERRIDES = [
  'PORCH_BIN_CODEX', 'PORCH_BIN_CLAUDE', 'PORCH_BIN_OPENCODE', 'PORCH_BIN_GROK', 'PORCH_BIN_GEMINI', 'PORCH_BIN_DEVIN', 'PORCH_BIN_AGY',
  'CODEX_MODEL', 'CLAUDE_MODEL', 'OPENCODE_MODEL', 'GROK_MODEL', 'GEMINI_MODEL', 'DEVIN_MODEL', 'AGY_MODEL',
  'CODEX_EFFORT', 'CLAUDE_EFFORT', 'OPENCODE_EFFORT', 'GROK_EFFORT', 'AGY_EFFORT',
]

export function porchEnvironment(directory: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['PORCH_DUMP_ARGV', 'PORCH_DEBUG_EVENTS', 'PORCH_DEBUG_EVENTS_PATH', 'PORCH_ARTIFACT_KEY', 'PORCH_RAW_PROMPT', 'PORCH_SKIP_OUTPUT_TEMPLATE', 'PORCH_OUTPUT_SCHEMA', 'PORCH_MEDIA_IMAGES', ...PORCH_PROVIDER_CREDENTIALS, ...PORCH_INHERITED_OVERRIDES]) delete env[key]
  return { ...env, TMPDIR: directory, TMP: directory, TEMP: directory,
    PORCH_PROGRESS: 'none', PORCH_PROGRESS_STYLE: 'none', PORCH_SAVE_OUTPUTS: '0',
    PORCH_RUN_DIR: join(directory, 'run'), PORCH_OUTPUT_DIR: join(directory, 'outputs'), PORCH_SINGLE_AGENT: '1' }
}

export async function porchChildPathDirs(agyPath: string): Promise<string[]> {
  const dirs = [dirname(await executablePath('bash', 'Bash'))]
  for (const lookup of [() => executablePath(agyPath, 'Antigravity CLI (agy)'), () => executablePath('python3', 'Python 3')]) {
    try { dirs.push(dirname(await lookup())) }
    catch (error) { if (!(error instanceof HarnessError)) throw error }
  }
  return [...new Set(dirs)]
}

/** Shared read-only capabilities query for Settings and transcription validation. */
export async function readPorchCapabilities(o: {
  porch: string; bash: string; directory: string; processes: HarnessProcesses; pathDirs: string[]; signal?: AbortSignal
}): Promise<string[]> {
  const result = await o.processes.run({ label: 'Porch audio capabilities', executable: o.bash,
    args: [o.porch, 'media', 'capabilities', '--json'], cwd: o.directory,
    env: prependPath(porchEnvironment(o.directory), o.pathDirs), signal: o.signal,
    timeoutMs: 5000, stdoutLimit: 128 * 1024 })
  let capabilities: unknown
  try { capabilities = JSON.parse(result.stdout) } catch { throw new HarnessError('Porch did not return valid media capabilities. Install the supported pragmatic-orchestration package.', 'bad-response', 0, undefined, true, 'Porch') }
  if (!capabilities || typeof capabilities !== 'object' || !('transcribe' in capabilities)
    || !Array.isArray(capabilities.transcribe) || !capabilities.transcribe.every(value => typeof value === 'string')) {
    throw new HarnessError('Porch did not return valid audio profile capabilities. Install the supported pragmatic-orchestration package.', 'bad-response', 0, undefined, true, 'Porch')
  }
  return capabilities.transcribe
}

/**
 * One trusted, configured profile. Porch retains its provider's permissions and authentication.
 * Select subscription-account profiles: arbitrary profiles can instead be configured for API billing.
 * This adapter is not a universal tool sandbox and does not invoke review-ask or delegate modes.
 */
export function createPorch(settings: AiSettings, processes: HarnessProcesses) {
  let resolved: ReturnType<typeof porchInstallation> | undefined
  const installation = () => (resolved ??= porchInstallation(settings.porchPath).catch(error => { resolved = undefined; throw error }))
  const requireAudioProfile = async (directory: string, signal?: AbortSignal) => {
    const profile = exactProfile(settings.transcriptionProfile)
    const { porch, bash } = await installation()
    const transcribe = await readPorchCapabilities({ porch, bash, directory, processes,
      pathDirs: await porchChildPathDirs(settings.agyPath), signal })
    if (!transcribe.includes(profile)) {
      throw new HarnessError('The selected Porch transcription profile does not support native audio. Choose one exact antigravity-cli profile listed by porch media capabilities --json.', 'cli-config', 0, undefined, true, 'Porch')
    }
  }
  return {
    async text(prompt: string, directory: string, signal?: AbortSignal): Promise<string> {
      const profile = exactProfile(settings.textProfile)
      const { runner, bash } = await installation()
      // The text profile may use a non-agy backend: an unresolvable agy path must not fail it.
      // Porch reports its own error when the selected profile really needs agy.
      let agy: string | undefined
      try { agy = await executablePath(settings.agyPath, 'Antigravity CLI (agy)') }
      catch (error) { if (!(error instanceof HarnessError)) throw error }
      assertRunning(signal)
      const file = join(directory, 'prompt.txt')
      await writeFile(file, prompt, { encoding: 'utf8', mode: 0o600 })
      // review ask adds an advisory template; delegate is unrestricted. Neither is an application completion API.
      // No model override: the selected profile chooses the text harness, model and effort.
      const result = await processes.run({ label: 'Porch', executable: bash,
        args: [runner, '--mode', 'media', '--agent-id', profile, '--raw', '--prompt-file', file],
        cwd: directory, env: prependPath({ ...porchEnvironment(directory), ...(agy ? { PORCH_BIN_AGY: agy } : {}) }, await porchChildPathDirs(settings.agyPath)), signal, timeoutMs: settings.timeoutSeconds * 1000,
        stdoutLimit: 2 * 1024 * 1024 })
        .catch(error => {
          if (agy === undefined && error instanceof HarnessError) {
            throw new HarnessError(`The Antigravity CLI (agy) was not found at the configured path: ${settings.agyPath}. An agy-backed text profile needs an absolute path to it when Yogurt is started from Finder. The original failure was reported by Porch.`, 'cli-missing', 0, undefined, true, 'agy')
          }
          throw error
        })
      if (!result.stdout.trim()) throw new HarnessError('Porch returned an empty final response.', 'bad-response', 0, undefined, true, 'Porch')
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
        env: prependPath({ ...porchEnvironment(directory), PORCH_BIN_AGY: agy, AGY_MODEL: settings.transcriptionModel,
          AGY_EFFORT: clampTranscriptionEffort(settings.transcriptionEffort), PORCH_OUTPUT_SCHEMA: schema }, await porchChildPathDirs(settings.agyPath)),
        signal, timeoutMs: Math.max(settings.timeoutSeconds, MIN_AUDIO_TIMEOUT_SECONDS) * 1000, stdoutLimit: 2 * 1024 * 1024 })
      if (!result.stdout.trim()) throw new HarnessError('Porch transcription returned an empty response.', 'bad-response', 0, undefined, true, 'Porch')
      return result.stdout
    },
  }
}
