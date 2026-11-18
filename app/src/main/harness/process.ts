import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AiProblemCode } from '../../shared/ai'

/** Errors deliberately omit provider diagnostics: they can contain meeting text or credentials. */
export class HarnessError extends Error {
  constructor(message: string, readonly code?: AiProblemCode, readonly attempts = 0, readonly model?: string) { super(message); this.name = 'HarnessError' }
}

export function aborted(): Error {
  const error = new Error('AI request cancelled')
  error.name = 'AbortError'
  return error
}

export function assertRunning(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted()
}

/** Resolve a real executable, including symlinks, without a shell or login-shell evaluation. */
export async function executablePath(value: string, label: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!value.trim() || /[\0\r\n]/.test(value)) throw new HarnessError(`${label}: select an executable file.`)
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  const explicit = isAbsolute(expanded) || /[/\\]/.test(expanded)
  const names = process.platform === 'win32' && !/\.[^/\\]+$/.test(expanded) ? [expanded, `${expanded}.exe`, `${expanded}.com`] : [expanded]
  const home = env.HOME || env.USERPROFILE || homedir()
  // A GUI launch (Finder) gets a minimal PATH; well-known install dirs are the fallback, in this order.
  const directories = explicit ? [] : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const paths = explicit ? names.map(n => resolve(n)) : (env.PATH || env.Path || '').split(delimiter).filter(Boolean).concat(directories).flatMap(dir => names.map(n => join(dir, n)))
  for (const candidate of paths) {
    try {
      const path = await realpath(candidate)
      if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(path)) {
        throw new HarnessError(`${label}: select a native .exe executable. Windows command scripts are not supported.`)
      }
      if (!(await stat(path)).isFile()) continue
      await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return path
    } catch (error) {
      if (error instanceof HarnessError) throw error
    }
  }
  throw new HarnessError(`${label} was not found. Install it and select its executable path in AI settings.`)
}

/** Prepend directories to a child environment's PATH so a Finder launch finds what the checks resolved. */
export function prependPath(env: NodeJS.ProcessEnv, directories: string[]): NodeJS.ProcessEnv {
  const dirs = [...new Set(directories)]
  if (!dirs.length) return env
  const key = 'PATH' in env ? 'PATH' : 'Path' in env ? 'Path' : 'PATH'
  const current = env[key]
  env[key] = [...dirs, ...(typeof current === 'string' && current ? current.split(delimiter) : [])].join(delimiter)
  return env
}

type ProcessOptions = {
  label: string
  executable: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  signal?: AbortSignal
  timeoutMs: number
  /** Called with each stdout chunk as text arrives; the buffered result still owns the full output. */
  onStdout?: (chunk: string) => void
  stdoutLimit?: number
  stderrLimit?: number
  acceptExitCodes?: number[]
}
export type ProcessResult = { stdout: string; stderr: string; exitCode: number }

/** A dedicated process group contains the CLI, its shell/Python helpers, and ordinary descendants. */
function signalTree(child: ChildProcess, force: boolean): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // taskkill is an OS executable; neither command interpolation nor shell=true is used.
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => { try { child.kill() } catch { /* already gone */ } })
    killer.unref()
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* group has already exited */ }
  }
}

export class HarnessProcesses {
  private controller = new AbortController()
  private children = new Set<ChildProcess>()
  readonly signal = this.controller.signal

  stop(): void {
    this.controller.abort()
    // Quitting the application may not leave an event loop for graceful escalation timers.
    for (const child of this.children) signalTree(child, true)
  }

  async run(options: ProcessOptions): Promise<ProcessResult> {
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal
    assertRunning(signal)
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new HarnessError('AI request timeout must be positive.')
    const stdoutLimit = options.stdoutLimit ?? 4 * 1024 * 1024
    const stderrLimit = options.stderrLimit ?? 128 * 1024
    return new Promise<ProcessResult>((resolveResult, reject) => {
      const child = spawn(options.executable, options.args, {
        cwd: options.cwd, env: options.env ?? process.env, shell: false,
        detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.children.add(child)
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      const stdoutText = new StringDecoder('utf8')
      const stdoutHandler = options.onStdout
      let stdoutHandlerFailed = false
      const emitStdout = (text: string) => {
        if (!stdoutHandler || stdoutHandlerFailed) return
        try { stdoutHandler(text) }
        catch (error) {
          // A throwing callback must not hang or crash the run; the buffered output still owns it.
          stdoutHandlerFailed = true
          console.warn(`${options.label} output handler failed.`, error)
        }
      }
      let stdoutFlushed = false
      const flushStdout = () => {
        if (stdoutFlushed) return
        stdoutFlushed = true
        emitStdout(stdoutText.end())
      }
      let outBytes = 0, errBytes = 0
      let error: Error | undefined
      let finished = false, closed = false, code: number | null = null
      let killTimer: NodeJS.Timeout | undefined
      let forceTimer: NodeJS.Timeout | undefined
      let killing = false
      const finish = () => {
        if (finished || !closed || killing) return
        finished = true
        this.children.delete(child)
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        if (forceTimer) clearTimeout(forceTimer)
        signal.removeEventListener('abort', onAbort)
        if (error) return reject(error)
        if (code === null || !(options.acceptExitCodes ?? [0]).includes(code)) {
          return reject(new HarnessError(`${options.label} failed${code === null ? '' : ` (exit ${code})`}. Check its terminal sign-in, model access, and quota.`))
        }
        resolveResult({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code })
      }
      const cancel = (reason: Error) => {
        if (finished || error) return
        error = reason
        killing = true
        signalTree(child, false)
        // Wait through escalation even when the CLI exits first: its descendants may still own files or pipes.
        killTimer = setTimeout(() => {
          signalTree(child, true)
          killing = false
          if (closed) finish()
          else forceTimer = setTimeout(() => {
            child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
            flushStdout()
            closed = true
            finish()
          }, 250)
        }, 250)
      }
      const onAbort = () => cancel(aborted())
      const timer = setTimeout(() => {
        const timeout = new HarnessError(`${options.label} timed out. Increase the AI request timeout or check the CLI in a terminal.`)
        timeout.name = 'TimeoutError'
        cancel(timeout)
      }, options.timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', () => {
        // No raw OS message: it can contain a sensitive argv or path.
        error ??= new HarnessError(`${options.label} could not start. Check its executable path and installation.`)
        closed = true
        finish()
      })
      child.stdout.on('data', (chunk: Buffer) => {
        emitStdout(stdoutText.write(chunk))
        outBytes += chunk.length
        if (outBytes > stdoutLimit) cancel(new HarnessError(`${options.label} exceeded the response size limit.`))
        else if (!error) stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        errBytes += chunk.length
        if (errBytes > stderrLimit) cancel(new HarnessError(`${options.label} exceeded the diagnostic size limit.`))
        else if (!error) stderr.push(chunk)
      })
      child.stdin.on('error', () => cancel(new HarnessError(`${options.label} closed its input before accepting the request.`)))
      child.on('close', exitCode => { flushStdout(); closed = true; code = exitCode; finish() })
      // Register EPIPE handling before writing; an auth/startup failure may close stdin immediately.
      child.stdin.end(options.input ?? '')
      if (signal.aborted) onAbort()
    })
  }
}

export async function inStage<T>(base: string, signal: AbortSignal | undefined, work: (directory: string) => Promise<T>): Promise<T> {
  assertRunning(signal)
  await mkdir(base, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(base, 'yogurt-ai-'))
  try {
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    assertRunning(signal)
    return await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}
