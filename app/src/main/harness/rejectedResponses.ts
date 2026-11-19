import { chmod, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REJECTED_RESPONSE_MAX_BYTES = 256 * 1024
export const REJECTED_RESPONSE_MAX_FILES = 20
export const REJECTED_RESPONSE_MAX_AGE_MS = 14 * 24 * 60 * 60_000

/** Keep a bounded, private copy beside the meeting spool so meeting deletion removes it too. */
export async function keepRejectedResponse(spoolDir: string, name: string, response: string, now = Date.now()): Promise<string | undefined> {
  const bytes = Buffer.byteLength(response, 'utf8')
  if (!/^[0-9a-f-]+-attempt-[12]$/.test(name) || bytes > REJECTED_RESPONSE_MAX_BYTES) return
  const dir = join(spoolDir, 'rejected')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const files: Array<{ path: string; mtime: number }> = []
  for (const file of await readdir(dir)) {
    if (!/^.+-attempt-[12]\.txt$/.test(file)) continue
    const path = join(dir, file)
    try {
      const info = await lstat(path)
      if (!info.isFile()) continue
      if (now - info.mtimeMs > REJECTED_RESPONSE_MAX_AGE_MS) await rm(path, { force: true })
      else files.push({ path, mtime: info.mtimeMs })
    } catch { /* a concurrently removed file is already outside the cap */ }
  }
  files.sort((a, b) => a.mtime - b.mtime)
  while (files.length >= REJECTED_RESPONSE_MAX_FILES) {
    const oldest = files.shift()!
    await rm(oldest.path, { force: true }).catch(() => {})
  }
  const path = join(dir, `${name}.txt`)
  await writeFile(path, response, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600)
  // Confirm the final entry is a plain file of the expected size, rather than a link or partial write.
  const info = await stat(path)
  if (!info.isFile() || info.size !== bytes) {
    await rm(path, { force: true })
    throw new Error('Rejected response file did not match its expected size.')
  }
  return path
}
