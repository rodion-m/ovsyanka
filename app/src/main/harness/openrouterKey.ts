import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiKeyStatus, AiProblemCode } from '../../shared/ai'
import { keyLast4 } from '../settings'
import { HarnessError } from './process'

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key'
export const OPENROUTER_KEY_FILE = 'secrets/openrouter.bin'
const OPENROUTER_KEY_RE = /^sk-or-v1-[0-9a-fA-F]{64}$/

export type OpenRouterKeyFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export type OpenRouterKeyStoreOptions = {
  userData: string
  safeStorage: SafeStorageLike
  fetch: OpenRouterKeyFetch
  /** A developer-only launch key. It remains memory-only and is never written to disk. */
  envKey?: string
  now?: () => number
}

type KeyMetadata = { label?: string; remainingUsd?: number | null; checkedAt?: number }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 200 && !/[\0-\x1f\x7f]/.test(value) ? value : undefined
}

function remaining(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function keyData(value: unknown): KeyMetadata {
  const root = record(value)
  const data = record(root?.data) ?? root
  const limit = remaining(data?.limit_remaining)
  return {
    ...(safeLabel(data?.label) ? { label: safeLabel(data?.label) } : {}),
    ...(limit === undefined ? {} : { remainingUsd: limit }),
  }
}

function responseOk(response: Response): boolean {
  return typeof response.ok === 'boolean' ? response.ok : response.status >= 200 && response.status < 300
}

function statusFor(source: 'keychain' | 'env', key: string, metadata: KeyMetadata = {}, state: 'ok' | 'rejected' | 'unchecked' = 'unchecked', problem?: AiProblemCode): AiKeyStatus {
  // Keep all returned fields explicit: no key or token is ever part of a status.
  return {
    state, source, last4: keyLast4(key),
    ...(metadata.label ? { label: metadata.label } : {}),
    ...(metadata.remainingUsd !== undefined ? { remainingUsd: metadata.remainingUsd } : {}),
    ...(metadata.checkedAt === undefined ? {} : { checkedAt: metadata.checkedAt }),
    ...(problem ? { problem } : {}),
  }
}

export function isOpenRouterKey(value: unknown): value is string {
  return typeof value === 'string' && OPENROUTER_KEY_RE.test(value)
}

export class OpenRouterKeyStore {
  private readonly file: string
  private readonly now: () => number
  private checked: { key: string; status: AiKeyStatus } | undefined

  constructor(private readonly options: OpenRouterKeyStoreOptions) {
    this.file = join(options.userData, OPENROUTER_KEY_FILE)
    this.now = options.now ?? (() => Date.now())
  }

  private encryptionAvailable(): boolean {
    try {
      return this.options.safeStorage.isEncryptionAvailable()
        && this.options.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
    } catch {
      return false
    }
  }

  private envStatus(): AiKeyStatus | undefined {
    const key = this.options.envKey
    if (key === undefined) return undefined
    if (!isOpenRouterKey(key)) return statusFor('env', key, {}, 'rejected', 'auth')
    if (this.checked?.key === key) return this.checked.status
    return statusFor('env', key)
  }

  private async readStored(): Promise<{ key: string } | { state: 'unavailable' | 'none' | 'unreadable' }> {
    if (!this.encryptionAvailable()) return { state: 'unavailable' }
    let encrypted: Buffer
    try { encrypted = await readFile(this.file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'none' }
      return { state: 'unreadable' }
    }
    try {
      const key = this.options.safeStorage.decryptString(encrypted)
      return isOpenRouterKey(key) ? { key } : { state: 'unreadable' }
    } catch {
      return { state: 'unreadable' }
    }
  }

  private async keyForRequest(): Promise<string> {
    const env = this.options.envKey
    if (env !== undefined) {
      if (!isOpenRouterKey(env)) throw new HarnessError('The OpenRouter API key is invalid.', 'auth')
      return env
    }
    const stored = await this.readStored()
    if ('key' in stored) return stored.key
    if (stored.state === 'unavailable') throw new HarnessError('OpenRouter key storage is unavailable.', 'keychain')
    if (stored.state === 'unreadable') throw new HarnessError('The saved OpenRouter key cannot be read by this build.', 'keychain')
    throw new HarnessError('Add an OpenRouter API key in Settings before transcribing.', 'no-key')
  }

  private async request(key: string, signal?: AbortSignal): Promise<{ status: number; response: Response; body: unknown }> {
    let response: Response
    try {
      response = await this.options.fetch(OPENROUTER_KEY_URL, {
        method: 'GET', signal,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      })
    } catch (error) {
      if (signal?.aborted) throw new HarnessError('The OpenRouter key check was cancelled.', 'network')
      throw new HarnessError('Could not reach OpenRouter to check the key.', 'network')
    }
    let body: unknown = undefined
    try { body = await response.json() as unknown } catch { /* the status below is enough for rejection */ }
    return { status: response.status, response, body }
  }

  private async verify(key: string, signal?: AbortSignal): Promise<{ status: AiKeyStatus; accepted: boolean }> {
    const result = await this.request(key, signal)
    if (!responseOk(result.response)) {
      const problem = result.status === 401 ? 'auth' : result.status >= 500 ? 'unavailable' : 'bad-response'
      return { status: statusFor('keychain', key, {}, 'rejected', problem), accepted: false }
    }
    const metadata = { ...keyData(result.body), checkedAt: this.now() }
    return { status: statusFor('keychain', key, metadata, 'ok'), accepted: true }
  }

  async status(): Promise<AiKeyStatus> {
    const env = this.envStatus()
    if (env) return env
    const stored = await this.readStored()
    if ('key' in stored) {
      if (this.checked?.key === stored.key) return this.checked.status
      return statusFor('keychain', stored.key)
    }
    return { state: stored.state }
  }

  async set(key: string, signal?: AbortSignal): Promise<AiKeyStatus> {
    if (this.options.envKey !== undefined) return this.status()
    if (!isOpenRouterKey(key)) return statusFor('keychain', typeof key === 'string' ? key : '', {}, 'rejected', 'auth')
    if (!this.encryptionAvailable()) return { state: 'unavailable' }
    const checked = await this.verify(key, signal)
    if (!checked.accepted) return checked.status
    try {
      await mkdir(join(this.options.userData, 'secrets'), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      try {
        const encrypted = this.options.safeStorage.encryptString(key)
        await writeFile(temporary, encrypted, { mode: 0o600 })
        await chmod(temporary, 0o600)
        await rename(temporary, this.file)
        await chmod(this.file, 0o600)
        this.checked = { key, status: checked.status }
        return checked.status
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    } catch {
      return { state: 'unavailable' }
    }
  }

  async check(signal?: AbortSignal): Promise<AiKeyStatus> {
    const key = await this.keyForRequest()
    const source: 'keychain' | 'env' = this.options.envKey !== undefined ? 'env' : 'keychain'
    const result = await this.request(key, signal)
    if (!responseOk(result.response)) {
      const problem = result.status === 401 ? 'auth' : result.status >= 500 ? 'unavailable' : 'bad-response'
      const status = statusFor(source, key, {}, 'rejected', problem)
      this.checked = { key, status }
      return status
    }
    const status = statusFor(source, key, { ...keyData(result.body), checkedAt: this.now() }, 'ok')
    this.checked = { key, status }
    return status
  }

  async clear(): Promise<AiKeyStatus> {
    if (this.options.envKey !== undefined) return this.status()
    this.checked = undefined
    await rm(this.file, { force: true }).catch(() => undefined)
    return this.status()
  }

  /** Read the key for one request. The file is decrypted again on every call. */
  async read(): Promise<string> {
    return this.keyForRequest()
  }
}

export const createOpenRouterKeyStore = (options: OpenRouterKeyStoreOptions): OpenRouterKeyStore => new OpenRouterKeyStore(options)
