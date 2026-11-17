import { rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** agy keeps every stream-json conversation, including audio, under this private store. */
export function agyStoreRoot(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

/** The first conversation UUID in NDJSON output. Non-UUID and path-like values never count. */
export function conversationId(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('conversation_id')) continue
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const message = event as Record<string, unknown>
    for (const holder of [message, message.init, message.step_update, message.result]) {
      if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue
      const id = (holder as Record<string, unknown>).conversation_id
      if (typeof id === 'string' && CONVERSATION_ID.test(id)) return id
    }
  }
  return undefined
}

const gone = (path: string) => stat(path).then(() => false, () => true)

let warnedAboutLayout = false

/**
 * Delete exactly the entries agy writes for one conversation id — never by pattern, age, or diff.
 * Other conversations and unrelated files are untouched.
 */
export async function forgetConversation(id: string, root: string = agyStoreRoot()): Promise<void> {
  if (!CONVERSATION_ID.test(id)) return
  const db = join(root, 'conversations', `${id}.db`)
  const brain = join(root, 'brain', id)
  const hadDb = !(await gone(db))
  await Promise.all([
    rm(db, { force: true }),
    rm(brain, { recursive: true, force: true }),
    rm(join(root, 'presence', `${id}.lock`), { force: true }),
    rm(join(root, 'annotations', `${id}.pbtxt`), { force: true }),
  ])
  if (!(await gone(db)) || !(await gone(brain))) throw new Error('agy conversation files remained after cleanup.')
  if (!hadDb && !warnedAboutLayout) {
    warnedAboutLayout = true
    console.warn('agy kept no conversation database for a request Yogurt made; its store layout may have changed, so a copy of the conversation can remain.')
  }
}
