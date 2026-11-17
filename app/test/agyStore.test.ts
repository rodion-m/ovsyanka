import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendForget, conversationId, forgetConversation, processForgetJournal, removeForget } from '../src/main/harness/agyStore'

const ID = 'b32e1fb5-0eef-4b17-a4b9-d1408fed4f7b'
const OTHER = '0eef4b17-a4b9-4b17-b32e-1fb5d1408fed'
const isWindows = process.platform === 'win32'
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function tempRoot() { const path = await mkdtemp(join(tmpdir(), 'agy-store-')); roots.push(path); return path }
const event = (value: unknown) => JSON.stringify(value)
const spawned = () => Date.now() - 60_000

async function seed(root: string, id: string) {
  await mkdir(join(root, 'conversations'), { recursive: true })
  await mkdir(join(root, 'brain', id), { recursive: true })
  await mkdir(join(root, 'presence'), { recursive: true })
  await mkdir(join(root, 'annotations'), { recursive: true })
  await writeFile(join(root, 'conversations', `${id}.db`), 'db')
  await writeFile(join(root, 'brain', id, 'audio.wav'), 'wav')
  await writeFile(join(root, 'presence', `${id}.lock`), 'lock')
  await writeFile(join(root, 'annotations', `${id}.pbtxt`), 'pb')
}
const entries = (root: string, id: string) => [
  join(root, 'conversations', `${id}.db`), join(root, 'brain', id),
  join(root, 'presence', `${id}.lock`), join(root, 'annotations', `${id}.pbtxt`),
]

describe('agy conversation id', () => {
  it('takes the id from the init event', () => {
    expect(conversationId(event({ event: 'init', conversation_id: ID, init: { model: 'm' } }) + '\n')).toBe(ID)
  })
  it('lowercases the id before it can build store paths', () => {
    expect(conversationId(event({ event: 'init', conversation_id: ID.toUpperCase() }) + '\n')).toBe(ID)
  })
  it('accepts the id nested in init and keeps the first one', () => {
    const first = event({ event: 'init', conversation_id: ID })
    const nested = event({ event: 'init', init: { conversation_id: OTHER } })
    expect(conversationId(`${first}\n${nested}\n`)).toBe(ID)
    expect(conversationId(event({ event: 'init', init: { conversation_id: ID } }))).toBe(ID)
  })
  it('never takes an id from step_update, result, or a non-init event', () => {
    expect(conversationId(event({ event: 'step_update', step_update: { conversation_id: ID } }))).toBeUndefined()
    expect(conversationId(event({ event: 'result', result: { conversation_id: ID } }))).toBeUndefined()
    expect(conversationId(event({ event: 'result', conversation_id: ID }))).toBeUndefined()
    expect(conversationId(`${event({ event: 'init' })}\n${event({ event: 'result', result: { conversation_id: ID } })}\n`)).toBeUndefined()
  })
  it.each([
    event({ event: 'init', conversation_id: '../x' }),
    event({ event: 'init', conversation_id: 'not-a-uuid' }),
    event({ event: 'init', conversation_id: 42 }),
    event({ event: 'init', conversation_id: null }),
    'plain text without json',
    '',
  ])('ignores output without a UUID conversation id (%#)', text => {
    expect(conversationId(text)).toBeUndefined()
  })
})

describe('agy conversation cleanup', () => {
  it('removes exactly the entries for the id and leaves other conversations and files', async () => {
    const root = await tempRoot()
    await seed(root, ID); await seed(root, OTHER)
    await writeFile(join(root, 'unrelated.txt'), 'keep')
    await forgetConversation(ID, root, spawned())
    for (const path of entries(root, ID)) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const path of entries(root, OTHER)) await expect(stat(path)).resolves.toBeTruthy()
    await expect(stat(join(root, 'unrelated.txt'))).resolves.toBeTruthy()
  })
  it('removes the SQLite sidecar files with the database', async () => {
    const root = await tempRoot()
    await seed(root, ID)
    for (const suffix of ['-wal', '-shm', '-journal']) await writeFile(join(root, 'conversations', `${ID}.db${suffix}`), 'x')
    await forgetConversation(ID, root, spawned())
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await expect(stat(join(root, 'conversations', `${ID}.db${suffix}`))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  it('never deletes outside the store for a non-UUID id', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'escape.db'), 'keep')
    await forgetConversation('../escape', root, spawned())
    await expect(stat(join(root, 'escape.db'))).resolves.toBeTruthy()
  })
  it('refuses to delete a database older than the request spawn and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = await tempRoot()
    await seed(root, ID)
    await forgetConversation(ID, root, Date.now() + 60_000)
    await forgetConversation(ID, root, Date.now() + 60_000)
    for (const path of entries(root, ID)) await expect(stat(path)).resolves.toBeTruthy()
    expect(warn).toHaveBeenCalledTimes(1)
  })
  it.skipIf(isWindows)('reports a stat failure instead of treating the copy as gone', async () => {
    const root = await tempRoot()
    await seed(root, ID)
    await chmod(join(root, 'conversations'), 0o000)
    try {
      await expect(forgetConversation(ID, root, spawned())).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(join(root, 'conversations'), 0o700)
    }
    for (const path of entries(root, ID)) await expect(stat(path)).resolves.toBeTruthy()
  })
  it('warns once per run when the conversation db was absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = await tempRoot()
    await forgetConversation(ID, root, spawned())
    await forgetConversation(ID, root, spawned())
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('agy forget journal', () => {
  it('appends entries atomically, dedupes by id and removes them', async () => {
    const dir = await tempRoot(), journal = join(dir, 'agy-forget.json')
    await appendForget(journal, { id: ID, notBefore: 1_000 })
    await appendForget(journal, { id: ID, notBefore: 2_000 })
    await appendForget(journal, { id: OTHER, notBefore: 3_000 })
    expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual([
      { id: ID, notBefore: 1_000 }, { id: OTHER, notBefore: 3_000 },
    ])
    await removeForget(journal, ID)
    expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual([{ id: OTHER, notBefore: 3_000 }])
    await removeForget(journal, OTHER)
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('replays a leftover entry from a killed run against the store', async () => {
    const dir = await tempRoot(), store = join(dir, 'store'), journal = join(dir, 'agy-forget.json')
    await seed(store, ID)
    await writeFile(journal, JSON.stringify([{ id: ID, notBefore: spawned() }]))
    await processForgetJournal(journal, store)
    for (const path of entries(store, ID)) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('leaves store files alone when the journaled database is older than notBefore', async () => {
    const dir = await tempRoot(), store = join(dir, 'store'), journal = join(dir, 'agy-forget.json')
    await seed(store, ID)
    await writeFile(journal, JSON.stringify([{ id: ID, notBefore: Date.now() + 60_000 }]))
    await processForgetJournal(journal, store)
    for (const path of entries(store, ID)) await expect(stat(path)).resolves.toBeTruthy()
    await expect(stat(journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.skipIf(isWindows)('keeps entries whose cleanup fails for the next launch', async () => {
    const dir = await tempRoot(), store = join(dir, 'store'), journal = join(dir, 'agy-forget.json')
    await seed(store, ID)
    const entry = { id: ID, notBefore: spawned() }
    await writeFile(journal, JSON.stringify([entry]))
    await chmod(join(store, 'conversations'), 0o000)
    try { await processForgetJournal(journal, store) }
    finally { await chmod(join(store, 'conversations'), 0o700) }
    expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual([entry])
  })
})
