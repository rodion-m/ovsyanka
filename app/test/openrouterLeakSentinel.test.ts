import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { aiSettings } from '../src/shared/ai'
import { hookAiPreferences } from '../src/main/harness/ipc'
import { OpenRouterKeyStore } from '../src/main/harness/openrouterKey'
import { openStore } from '../src/main/store'
import { exportBackup } from '../src/main/backup'
import { unpack } from '../src/main/zip'
import { logToFile } from '../src/main/log'

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
  it('checks real IPC responses, main.log, backup export and encrypted key files', async () => {
    userData = await mkdtemp(join(tmpdir(), 'yogurt-openrouter-leak-'))
    const dir = userData
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'secure',
      encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
      decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
    }
    const keyStore = new OpenRouterKeyStore({
      userData: dir, safeStorage,
      fetch: async () => new Response(JSON.stringify({ data: { label: `team ${KEY.slice(-8)} account`, limit_remaining: 8 } }), { status: 200 }),
    })
    hookAiPreferences({
      file: join(dir, 'settings.json'), active: aiSettings({ backend: 'openrouter' }), restart: () => true, env: {}, openrouter: keyStore,
    })

    logToFile(join(dir, 'logs', 'main.log'))
    expect(await call('ai.openrouter.setKey', KEY)).toMatchObject({ state: 'ok', source: 'keychain' })
    expect(await call('ai:get')).toMatchObject({ active: { backend: 'openrouter' } })
    console.info('OpenRouter key status', await call('ai.openrouter.keyStatus'))
    expect(await call('ai.openrouter.checkKey')).toMatchObject({ state: 'ok', source: 'keychain' })
    expect(await call('ai.openrouter.usage')).toMatchObject({ costUnknown: false })
    expect(await call('ai.openrouter.clearKey')).toMatchObject({ state: 'none' })
    expect(await call('ai.openrouter.setKey', KEY)).toMatchObject({ state: 'ok', source: 'keychain' })

    const store = openStore(join(dir, 'yogurt.db'))
    try {
      store.createMeeting({ title: 'Sentinel export', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
      const backup = join(dir, 'backup.zip')
      await exportBackup({ db: store.db, meetingsDir: join(dir, 'meetings'), out: backup, appVersion: 'test' })
      await unpack(backup, join(dir, 'backup contents'))
    } finally { store.close() }

    const log = await readFile(join(dir, 'logs', 'main.log'), 'utf8')
    expect(log).not.toContain(KEY)
    expect(log).not.toContain(KEY.slice(-8))
    for (const response of responses) {
      const text = JSON.stringify(response)
      expect(text).not.toContain(KEY)
      expect(text).not.toContain(KEY.slice(-8))
    }
    for (const file of await filesUnder(dir)) {
      const contents = await readFile(file)
      expect(contents.includes(KEY)).toBe(false)
      expect(contents.includes(KEY.slice(-8))).toBe(false)
    }
  })
})
