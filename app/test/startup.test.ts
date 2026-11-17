import { describe, expect, it, vi } from 'vitest'
import { runCatchUp } from '../src/main/startup'

describe('launch catch-up order', () => {
  it('runs notes recovery, folder suggestions and indexing before spool recovery', async () => {
    const order: string[] = []
    runCatchUp({
      rejoined: Promise.resolve(),
      notes: { recover: () => { order.push('notes') } },
      folders: { refresh: () => { order.push('folders') } },
      index: { schedule: () => { order.push('index'); return Promise.resolve() } },
      recoverTranscripts: () => { order.push('recover'); return Promise.resolve() },
    })
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['notes', 'folders', 'index', 'recover'])
  })

  it('waits for the audio rejoin before any of it', async () => {
    const order: string[] = []
    let release!: () => void
    const rejoined = new Promise<void>((r) => { release = r })
    runCatchUp({
      rejoined,
      notes: { recover: () => { order.push('notes') } },
      folders: { refresh: () => { order.push('folders') } },
      index: { schedule: () => { order.push('index'); return Promise.resolve() } },
      recoverTranscripts: () => { order.push('recover'); return Promise.resolve() },
    })
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual([])
    release()
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['notes', 'folders', 'index', 'recover'])
  })

  it('a failed rejoin still lets the rest run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const order: string[] = []
    runCatchUp({
      rejoined: Promise.reject(new Error('join failed')),
      notes: { recover: () => { order.push('notes') } },
      folders: { refresh: () => { order.push('folders') } },
      index: { schedule: () => { order.push('index'); return Promise.resolve() } },
      recoverTranscripts: () => { order.push('recover'); return Promise.resolve() },
    })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['notes', 'folders', 'index', 'recover'])
    warn.mockRestore()
  })
})
