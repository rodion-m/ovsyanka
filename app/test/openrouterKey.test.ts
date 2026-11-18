import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenRouterKeyStore, OPENROUTER_KEY_FILE, type OpenRouterKeyFetch, type SafeStorageLike } from '../src/main/harness/openrouterKey'
import { keyLast4 } from '../src/main/settings'

const KEY = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })) ) })

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'yogurt-openrouter-key-'))
  roots.push(path)
  return path
}

async function filesUnder(path: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) out.push(...await filesUnder(child))
    else out.push(child)
  }
  return out
}

function storage(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'os_crypt',
    encryptString: value => Buffer.from(value.split('').reverse().join(''), 'utf8'),
    decryptString: value => value.toString('utf8').split('').reverse().join(''),
    ...over,
  }
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('OpenRouter key storage', () => {
  it('never reveals short values as a last-four label', () => {
    expect(keyLast4('tiny')).toBe('****')
    expect(keyLast4(KEY)).toBe(KEY.slice(-4))
  })
  it('encrypts with restrictive permissions, checks before saving, and only exposes metadata', async () => {
    const userData = await root()
    const fetch = vi.fn<OpenRouterKeyFetch>(async () => answer({ data: { label: 'meeting key', limit_remaining: 4.2 } }))
    const store = createOpenRouterKeyStore({ userData, safeStorage: storage(), fetch, now: () => 1_800_000_000_000 })

    const status = await store.set(KEY)
    expect(status).toMatchObject({ state: 'ok', source: 'keychain', last4: KEY.slice(-4), label: 'meeting key', remainingUsd: 4.2, checkedAt: 1_800_000_000_000 })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][1]?.headers).toEqual({ Authorization: `Bearer ${KEY}`, Accept: 'application/json' })
    const file = join(userData, OPENROUTER_KEY_FILE)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).not.toContain(KEY)
    expect(await store.read()).toBe(KEY)
    expect(await store.status()).toMatchObject({ state: 'ok', last4: KEY.slice(-4) })
    expect(JSON.stringify(await store.status())).not.toContain(KEY)
    expect(await store.clear()).toEqual({ state: 'none' })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not write when encryption is unavailable or basic_text is selected', async () => {
    const userData = await root()
    const fetch = vi.fn<OpenRouterKeyFetch>(async () => answer({ data: { label: 'unused' } }))
    for (const safeStorage of [
      storage({ isEncryptionAvailable: () => false }),
      storage({ getSelectedStorageBackend: () => 'basic_text' }),
    ]) {
      const store = createOpenRouterKeyStore({ userData, safeStorage, fetch })
      expect(await store.set(KEY)).toEqual({ state: 'unavailable' })
      expect(await store.status()).toEqual({ state: 'unavailable' })
    }
    expect(fetch).not.toHaveBeenCalled()
    await expect(stat(join(userData, OPENROUTER_KEY_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports an undecryptable key without crashing and never falls back to plaintext', async () => {
    const userData = await root()
    const file = join(userData, OPENROUTER_KEY_FILE)
    await mkdir(join(userData, 'secrets'), { recursive: true })
    await writeFile(file, Buffer.from('opaque ciphertext'), { mode: 0o600 })
    const store = createOpenRouterKeyStore({ userData, safeStorage: storage({ decryptString: () => { throw new Error('keychain refused') } }), fetch: vi.fn() })
    expect(await store.status()).toEqual({ state: 'unreadable' })
    await expect(store.read()).rejects.toMatchObject({ code: 'keychain' })
    expect(await readFile(file, 'utf8')).toBe('opaque ciphertext')
  })

  it('rejects invalid and server-rejected keys without storing them or echoing response bodies', async () => {
    const userData = await root()
    const echoed = `Authorization: Bearer ${KEY}`
    const fetch = vi.fn<OpenRouterKeyFetch>(async (_url, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization
      return new Response(JSON.stringify({ error: { type: 'auth', message: `${echoed} ${authorization}` } }), { status: 401 })
    })
    const store = createOpenRouterKeyStore({ userData, safeStorage: storage(), fetch })
    expect(await store.set('not-an-openrouter-key')).toMatchObject({ state: 'rejected', problem: 'auth' })
    expect(fetch).not.toHaveBeenCalled()
    const status = await store.set(KEY)
    expect(status).toMatchObject({ state: 'rejected', problem: 'auth', last4: KEY.slice(-4) })
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(JSON.stringify(status)).not.toContain(echoed)
    await expect(stat(join(userData, OPENROUTER_KEY_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a launch key in memory only and reports the last four characters', async () => {
    const userData = await root()
    const store = createOpenRouterKeyStore({ userData, safeStorage: storage({ isEncryptionAvailable: () => false }), fetch: vi.fn(), envKey: KEY })
    expect(await store.status()).toEqual({ state: 'unchecked', source: 'env', last4: KEY.slice(-4) })
    expect(await store.read()).toBe(KEY)
    expect(await store.clear()).toEqual({ state: 'unchecked', source: 'env', last4: KEY.slice(-4) })
    await expect(stat(join(userData, OPENROUTER_KEY_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drops labels containing any eight character key fragment and saves during transient outages', async () => {
    const userData = await root()
    const transient = createOpenRouterKeyStore({ userData, safeStorage: storage(), fetch: async () => answer({ error: {} }, 503) })
    expect(await transient.set(KEY)).toMatchObject({ state: 'unchecked', problem: 'unavailable' })
    expect(await transient.read()).toBe(KEY)
    const labeled = createOpenRouterKeyStore({ userData, safeStorage: storage(), fetch: async () => answer({ data: { label: `team ${KEY.slice(16, 24)} account` } }) })
    expect(await labeled.set(KEY)).not.toHaveProperty('label')
  })

  it('saves an unchecked key when verification returns an unreadable success body', async () => {
    const userData = await root()
    const store = createOpenRouterKeyStore({ userData, safeStorage: storage(), fetch: async () => new Response('not-json', { status: 200 }) })
    expect(await store.set(KEY)).toMatchObject({ state: 'unchecked', problem: 'bad-response' })
    expect(await store.read()).toBe(KEY)
  })

  it('saves an encrypted unchecked key when /key rejects or hangs, and reports no-key as none', async () => {
    const userData = await root()
    const rejected = createOpenRouterKeyStore({ userData, safeStorage: storage(), fetch: async () => { throw new Error('offline') } })
    expect(await rejected.set(KEY)).toMatchObject({ state: 'unchecked', problem: 'network' })
    expect(await rejected.check()).toMatchObject({ state: 'unchecked', problem: 'network' })
    const missing = createOpenRouterKeyStore({ userData: await root(), safeStorage: storage(), fetch: vi.fn() })
    expect(await missing.check()).toEqual({ state: 'none' })

    vi.useFakeTimers()
    try {
      const hanging = createOpenRouterKeyStore({ userData: await root(), safeStorage: storage(), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }) })
      const saved = hanging.set(KEY)
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(saved).resolves.toMatchObject({ state: 'unchecked', problem: 'timeout' })
      expect(await hanging.read()).toBe(KEY)
    } finally { vi.useRealTimers() }
  })

  it('passes the key-leak sentinel through save, check, 401, 500 and IPC-shaped responses', async () => {
    const userData = await root()
    const bodies = [
      { data: { label: 'sentinel', limit_remaining: null } },
      { data: { label: 'sentinel', limit_remaining: null } },
      { error: { type: 'auth', message: `echo Bearer ${KEY}` } },
      { error: { type: 'provider_unavailable', message: `echo headers Authorization: Bearer ${KEY}` } },
    ]
    const statuses: unknown[] = []
    const fetch = vi.fn<OpenRouterKeyFetch>(async (_url, init) => {
      // The fake server receives the header, but only the response metadata is retained below.
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
      const body = bodies.shift()! as { data?: unknown; error?: { type?: string } }
      return answer(body, body.error ? (body.error.type === 'auth' ? 401 : 500) : 200)
    })
    const store = createOpenRouterKeyStore({ userData, safeStorage: storage(), fetch, now: () => 1_800_000_000_000 })
    statuses.push(await store.set(KEY), await store.check(), await store.check(), await store.check())
    await writeFile(join(userData, 'logs-main.log'), JSON.stringify(statuses))
    const artifacts = [...await Promise.all((await filesUnder(userData)).map(path => readFile(path, 'utf8'))), JSON.stringify(statuses)]
    for (const artifact of artifacts) {
      expect(artifact).not.toContain(KEY)
      expect(artifact).not.toContain(KEY.slice(-8))
    }
    expect(statuses).toHaveLength(4)
    expect(statuses.every(value => JSON.stringify(value).includes(KEY) === false)).toBe(true)
  })
})
