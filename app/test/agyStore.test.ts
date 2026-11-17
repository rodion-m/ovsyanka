import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conversationId, forgetConversation } from '../src/main/harness/agyStore'

const ID = 'b32e1fb5-0eef-4b17-a4b9-d1408fed4f7b'
const OTHER = '0eef4b17-a4b9-4b17-b32e-1fb5d1408fed'
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function tempRoot() { const path = await mkdtemp(join(tmpdir(), 'agy-store-')); roots.push(path); return path }
const event = (value: unknown) => JSON.stringify(value)

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
  it('accepts the id nested in step_update and result events and keeps the first one', () => {
    const first = event({ event: 'init', conversation_id: ID })
    const nested = event({ event: 'result', result: { conversation_id: OTHER } })
    expect(conversationId(`${first}\n${nested}\n`)).toBe(ID)
    expect(conversationId(event({ event: 'step_update', step_update: { conversation_id: ID } }))).toBe(ID)
    expect(conversationId(event({ event: 'result', result: { conversation_id: ID } }))).toBe(ID)
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
  it('removes exactly the four entries for the id and leaves other conversations and files', async () => {
    const root = await tempRoot()
    await seed(root, ID); await seed(root, OTHER)
    await writeFile(join(root, 'unrelated.txt'), 'keep')
    await forgetConversation(ID, root)
    for (const path of entries(root, ID)) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const path of entries(root, OTHER)) await expect(stat(path)).resolves.toBeTruthy()
    await expect(stat(join(root, 'unrelated.txt'))).resolves.toBeTruthy()
  })
  it('never deletes outside the store for a non-UUID id', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'escape.db'), 'keep')
    await forgetConversation('../escape', root)
    await expect(stat(join(root, 'escape.db'))).resolves.toBeTruthy()
  })
  it('warns once per run when the conversation db was absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = await tempRoot()
    await forgetConversation(ID, root)
    await forgetConversation(ID, root)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
