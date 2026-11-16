import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiSettings } from '../../shared/ai'
import { assertRunning, executablePath, HarnessError, HarnessProcesses } from './process'
import { MIN_AUDIO_TIMEOUT_SECONDS } from './transcribe'

type Request = {
  prompt: string
  directory: string
  signal?: AbortSignal
  audio?: boolean
  schema?: Record<string, unknown>
}

/** agy 1.5.4+ stream-json contract, as used by Porch b0c5cf4. Never use deltas as a fallback answer. */
export function agyAnswer(stdout: string): string {
  let answer: string | undefined
  let results = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: unknown
    try { event = JSON.parse(line) } catch { throw new HarnessError('agy returned an invalid event stream.') }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new HarnessError('agy returned an invalid event stream.')
    const message = event as Record<string, unknown>
    if (message.event !== 'result') continue
    results++
    const result = message.result
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HarnessError('agy returned an invalid final result.')
    const value = result as Record<string, unknown>
    if (value.status !== 'SUCCESS' || value.finished_reason || value.error) {
      throw new HarnessError('agy did not complete the request. Check its terminal sign-in, model access, and quota.')
    }
    if (typeof value.response !== 'string' || !value.response.trim()) throw new HarnessError('agy returned an empty final response.')
    answer = value.response
  }
  if (results !== 1 || answer === undefined) throw new HarnessError('agy did not return exactly one completed result.')
  return answer
}

export function createAgy(settings: AiSettings, processes: HarnessProcesses) {
  let resolved: Promise<string> | undefined
  return async (request: Request): Promise<string> => {
    assertRunning(request.signal)
    const binary = await (resolved ??= executablePath(settings.agyPath, 'Antigravity CLI (agy)').catch(error => { resolved = undefined; throw error }))
    const deny = ['command(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)']
    if (!request.audio) deny.push('read_file(*)')
    const permissions = {
      // Pin these explicitly: recent agy versions default to Auto. User deny/ask rules still apply.
      agentMode: '', toolPermission: 'request-review', allowNonWorkspaceAccess: false,
      // Account/keyring authentication, without falling through to a previously configured paid API provider.
      modelProvider: '', useG1Credits: false,
      permissions: { deny, ...(request.audio ? { allow: [`read_file(${join(request.directory, 'audio.wav')})`] } : {}) },
    }
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands',
      '--settings', JSON.stringify(permissions), '--model', request.audio ? settings.transcriptionModel : settings.textModel,
      '--effort', request.audio ? settings.transcriptionEffort : settings.textEffort]
    if (request.schema) {
      const schemaPath = join(request.directory, 'schema.json')
      await writeFile(schemaPath, JSON.stringify(request.schema), { encoding: 'utf8', mode: 0o600 })
      args.push('--json-schema', schemaPath)
    }
    const env = { ...process.env }
    delete env.GEMINI_API_KEY
    delete env.GOOGLE_API_KEY
    delete env.AGY_ADC_AUTH
    assertRunning(request.signal)
    const result = await processes.run({ label: 'agy', executable: binary, args, cwd: request.directory, env,
      input: `${JSON.stringify({ event: 'user', message: { content: request.prompt } })}\n`,
      signal: request.signal, timeoutMs: (request.audio ? Math.max(settings.timeoutSeconds, MIN_AUDIO_TIMEOUT_SECONDS) : settings.timeoutSeconds) * 1000 })
    return agyAnswer(result.stdout)
  }
}
