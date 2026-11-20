import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { aiSettings } from '../src/shared/ai'
import { hookAiPreferences } from '../src/main/harness/ipc'
import { OpenRouterKeyStore, type OpenRouterKeyFetch } from '../src/main/harness/openrouterKey'
import { openStore } from '../src/main/store'
import { exportBackup } from '../src/main/backup'
import { unpack } from '../src/main/zip'
import { logToFile } from '../src/main/log'
import { createOpenRouter } from '../src/main/harness/openrouter'
import { tempDir } from './support/tempDir'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } }))
vi.mock('../src/main/harness/index', () => ({ checkHarness: vi.fn(async () => ({ ok: true, message: 'available' })) }))

const KEY = `sk-or-v1-${'abcdef0123456789'.repeat(4)}`
const responses: unknown[] = []
const call = async (name: string, ...args: unknown[]) => {
  const response = await handlers.get(name)!({}, ...args)
  responses.push(response)
  return response
}

let userData: string | undefined
const originalConsole = { info: console.info, warn: console.warn, error: console.error }

async function filesUnder(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

afterEach(async () => {
  console.info = originalConsole.info; console.warn = originalConsole.warn; console.error = originalConsole.error
  handlers.clear(); responses.length = 0
  if (userData) await rm(userData, { recursive: true, force: true })
  userData = undefined
})

describe('OpenRouter credential leak sentinel', () => {
  it('checks save, 401, header-echoing 500, adapter diagnostics, main.log, backup and encrypted files', async () => {
    userData = tempDir('openrouter-leak')
    const dir = userData
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'secure',
      encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
      decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
    }
    let keyRequests = 0
    const fetch: OpenRouterKeyFetch = async (url, init) => {
        if (!String(url).endsWith('/key')) return new Response(JSON.stringify({
          id: KEY.slice(8, 16), error_type: KEY.slice(16, 24), choices: [{ message: { content: 'safe answer' } }],
        }), { status: 200 })
        keyRequests++
        if (keyRequests === 1) return new Response(JSON.stringify({ data: { label: `team ${KEY.slice(-8)} account`, limit_remaining: 8 } }), { status: 200 })
        const authorization = (init?.headers as Record<string, string>).Authorization
        return keyRequests === 2
          ? new Response(JSON.stringify({ error: { type: 'auth', message: `echo ${authorization}` } }), { status: 401 })
          : new Response(JSON.stringify({ error: { type: 'provider_unavailable', message: `echo ${authorization}` } }), { status: 500 })
      }
    const keyStore = new OpenRouterKeyStore({ userData: dir, safeStorage, fetch })
    hookAiPreferences({
      file: join(dir, 'settings.json'), active: aiSettings({ backend: 'openrouter' }), restart: () => true, env: {}, openrouter: keyStore,
    })

    logToFile(join(dir, 'logs', 'main.log'))
    expect(await call('ai.openrouter.setKey', KEY)).toMatchObject({ state: 'ok', source: 'keychain' })
    expect(await call('ai:get')).toMatchObject({ active: { backend: 'openrouter' } })
    expect(await call('ai.openrouter.checkKey')).toMatchObject({ state: 'rejected', problem: 'auth' })
    expect(await call('ai.openrouter.checkKey')).toMatchObject({ state: 'unchecked', problem: 'unavailable' })
    expect(await call('ai.openrouter.usage')).toMatchObject({ transcriptionCostUnknown: false, textCostUnknown: false })
    const adapter = createOpenRouter({ settings: aiSettings({ backend: 'openrouter' }), key: keyStore, fetch })
    await expect(adapter.text('sentinel request', new AbortController().signal)).resolves.toBe('safe answer')

    const store = openStore(join(dir, 'yogurt.db'))
    try {
      store.createMeeting({ title: 'Sentinel export', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
      const backup = join(dir, 'backup.zip')
      await exportBackup({ db: store.db, meetingsDir: join(dir, 'meetings'), out: backup, appVersion: 'test' })
      await unpack(backup, join(dir, 'backup contents'))
    } finally { store.close() }

    const log = await readFile(join(dir, 'logs', 'main.log'), 'utf8')
    expect(log).toContain('openrouter request')
    expect(log).not.toContain(KEY)
    for (let i = 0; i <= KEY.length - 8; i++) expect(log).not.toContain(KEY.slice(i, i + 8))
    for (const response of responses) {
      const text = JSON.stringify(response)
      expect(text).not.toContain(KEY)
      for (let i = 0; i <= KEY.length - 8; i++) expect(text).not.toContain(KEY.slice(i, i + 8))
    }
    for (const file of await filesUnder(dir)) {
      const contents = await readFile(file)
      expect(contents.includes(KEY)).toBe(false)
      const text = contents.toString('utf8')
      for (let i = 0; i <= KEY.length - 8; i++) expect(text.includes(KEY.slice(i, i + 8))).toBe(false)
    }
  })
})
