import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** agy keeps every stream-json conversation, including audio, under this private store. */
export function agyStoreRoot(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

/** Pending cleanups live beside the harness staging dir so a quit mid-request replays them next launch. */
export function forgetJournalPath(tempDir: string): string {
  return join(tempDir, 'agy-forget.json')
}

/**
 * The conversation id agy announced in its init event, lowercased for store paths.
 * Ids in step_update, result, or any other event never count: only init proves this run owns it.
 */
export function conversationId(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('conversation_id')) continue
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const message = event as Record<string, unknown>
    if (message.event !== 'init') continue
    for (const holder of [message, message.init]) {
      if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue
      const id = (holder as Record<string, unknown>).conversation_id
      if (typeof id === 'string' && CONVERSATION_ID.test(id)) return id.toLowerCase()
    }
  }
  return undefined
}

export type PendingForget = { id: string; notBefore: number }

// Journal updates are read-modify-write; serialize them per path so a background replay and a
// live request can never interleave and lose an entry.
const journalQueues = new Map<string, Promise<void>>()
function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const run = (journalQueues.get(path) ?? Promise.resolve()).then(work)
  journalQueues.set(path, run.then(() => undefined, () => undefined))
  return run
}

const pendingForget = (value: unknown): value is PendingForget => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && CONVERSATION_ID.test(entry.id)
    && typeof entry.notBefore === 'number' && Number.isFinite(entry.notBefore)
}

async function readJournal(path: string): Promise<PendingForget[]> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(value)) return []
  return value.filter(pendingForget).map(entry => ({ id: entry.id.toLowerCase(), notBefore: entry.notBefore }))
}

async function writeJournal(path: string, entries: PendingForget[]): Promise<void> {
  if (!entries.length) { await rm(path, { force: true }); return }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(entries)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, path)
}

/** Record a captured conversation id so cleanup still happens if the app quits mid-request. */
export function appendForget(path: string, entry: PendingForget): Promise<void> {
  return serialized(path, async () => {
    const entries = await readJournal(path)
    if (!entries.some(existing => existing.id === entry.id)) entries.push(entry)
    await writeJournal(path, entries)
  })
}

/** Drop the journal entry once its conversation copy is gone or provably not this run's. */
export function removeForget(path: string, id: string): Promise<void> {
  const key = id.toLowerCase()
  return serialized(path, async () => {
    const entries = await readJournal(path)
    const kept = entries.filter(entry => entry.id !== key)
    if (kept.length !== entries.length) await writeJournal(path, kept)
  })
}

/**
 * Replay entries a previous run left behind — a quit or crash mid-request — under the same
 * ownership rule. Entries whose cleanup fails stay journaled for the next launch.
 */
export async function processForgetJournal(path: string, root: string = agyStoreRoot()): Promise<void> {
  await serialized(path, async () => {
    const entries = await readJournal(path)
    const remaining: PendingForget[] = []
    for (const entry of entries) {
      try { await forgetConversation(entry.id, root, entry.notBefore) }
      catch (error) {
        remaining.push(entry)
        console.warn('Yogurt could not remove a pending agy conversation copy.', error)
      }
    }
    await writeJournal(path, remaining)
  })
}

/** Only ENOENT counts as gone; any other stat failure is reported instead of treated as deleted. */
async function gone(path: string): Promise<boolean> {
  try { await stat(path); return false }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

let warnedAboutLayout = false
let warnedAboutForeign = false

/**
 * Delete exactly the entries agy writes for one conversation id — never by pattern or diff.
 * Ownership needs both proofs: the id came from this run's own init event, and agy's database
 * was created no earlier than `notBefore` (the spawn time minus a margin). A missing, older, or
 * unreadable database deletes nothing.
 */
export async function forgetConversation(id: string, root: string, notBefore: number): Promise<void> {
  if (!CONVERSATION_ID.test(id)) return
  id = id.toLowerCase()
  const db = join(root, 'conversations', `${id}.db`)
  const stats = await stat(db).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stats === null) {
    if (!warnedAboutLayout) {
      warnedAboutLayout = true
      console.warn('agy kept no conversation database for a request Yogurt made; its store layout may have changed, so a copy of the conversation can remain.')
    }
    return
  }
  // Filesystems without birth time report 0; the modification time is the fallback evidence.
  const created = stats.birthtimeMs || stats.mtimeMs
  if (created < notBefore) {
    if (!warnedAboutForeign) {
      warnedAboutForeign = true
      console.warn('An agy conversation copy predates this Yogurt run, so Yogurt left it in place.')
    }
    return
  }
  const candidates = [
    db, `${db}-wal`, `${db}-shm`, `${db}-journal`,
    join(root, 'brain', id),
    join(root, 'presence', `${id}.lock`),
    join(root, 'annotations', `${id}.pbtxt`),
  ]
  const existing: string[] = []
  for (const path of candidates) {
    try { await stat(path); existing.push(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await Promise.all(existing.map(path => rm(path, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 })))
  for (const path of existing) if (!(await gone(path))) throw new Error('agy conversation files remained after cleanup.')
}