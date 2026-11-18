import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAgyModels, parseAgyModels, mergeAgyModels } from '../src/main/harness/agyModels'
import { buildPorchOptions, loadPorchProfiles, parsePorchProfiles } from '../src/main/harness/porchProfiles'

const fixture = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures/cli', name), 'utf8')
afterEach(() => vi.unstubAllEnvs())

describe('Porch CLI catalog parsing', () => {
  it('parses the captured Mac output with hand-counted rows and the transcription capability IDs', () => {
    const profiles = parsePorchProfiles(fixture('porch-list-agents.txt'))
    expect(profiles).toHaveLength(72)
    expect(profiles[0]).toMatchObject({ id: 'codex', label: 'Codex GPT-6.2 Sol', backend: 'codex-cli', model: 'gpt-6.2-sol' })
    const capable: string[] = JSON.parse(fixture('porch-media-capabilities.json')).transcribe
    const expectedTranscribe = [
      'agy-gemini-3.8-flash', 'agy-gemini-4-argon', 'agy-gemini-4-carbon', 'agy-gemini-4-carbon-low',
      'agy-gemini-4-carbon-medium', 'agy-gemini-4-hydrogen', 'agy-gemini-4-hydrogen-low',
      'agy-gemini-4-hydrogen-medium', 'agy-gemini-4-hydrogen-xhigh',
    ]
    expect(capable).toEqual(expectedTranscribe)
    const options = buildPorchOptions(profiles, capable)
    expect(options.transcription).toHaveLength(9)
    expect(options.transcription.map(option => option.id).sort()).toEqual([...expectedTranscribe].sort())
    expect(options.text).toHaveLength(72)
  })

  it('decodes XML entities, ignores unknown attributes, and skips rows without IDs', () => {
    expect(parsePorchProfiles('<agent label="A &amp; B &quot;C&quot;" backend="agy" model="x" mystery="ok"/><agent id="one" label="One &lt;1&gt;" backend="agy" model="gemini" extra="x"/>'))
      .toEqual([{ id: 'one', label: 'One <1>', backend: 'agy', model: 'gemini', backendAvailable: true }])
  })

  it.each(['', '<porch-plan></porch-plan>', '<agent label="Missing backend"/>', '<agent id="bad id" label="Invalid" backend="agy" model="x"/>'])('rejects empty or malformed profile lists: %s', output => {
    expect(() => parsePorchProfiles(output)).toThrow()
  })
})

describe('agy models parsing', () => {
  it('parses captured model rows and merges live levels without losing built-in hints', () => {
    const rows = parseAgyModels(`${fixture('agy-models.stderr.txt')}${fixture('agy-models.txt')}`)
    expect(rows).toHaveLength(18)
    expect(rows.map(row => [row.id, row.effort ?? ''])).toEqual([
      ['gemini-4-argon', 'medium'], ['gemini-4-argon', 'high'], ['gemini-4-argon', 'low'],
      ['gemini-4-hydrogen', 'high'], ['gemini-4-hydrogen', 'xhigh'], ['gemini-4-hydrogen', 'medium'], ['gemini-4-hydrogen', 'low'],
      ['gemini-pro-orchestrator-g1-pro', ''],
      ['gemini-3.8-flash', 'high'], ['gemini-3.8-flash', 'medium'], ['gemini-3.8-flash', 'low'],
      ['claude-opus-5-5', 'low'], ['claude-opus-5-5', 'medium'], ['claude-opus-5-5', 'high'],
      ['claude-sonnet-5-5', 'low'], ['claude-sonnet-5-5', 'medium'], ['claude-sonnet-5-5', 'high'],
      ['gpt-oss-120b', 'medium'],
    ])
    const merged = mergeAgyModels(rows)
    expect(merged.find(option => option.id === 'gemini-3.8-flash')).toMatchObject({
      label: 'Gemini 3.8 Flash', hints: ['audio', 'verified'], efforts: ['low', 'medium', 'high'],
    })
  })

  it('strips a progress line and groups low, medium, high, xhigh and max suffixes by base ID', () => {
    expect(parseAgyModels('Fetching available models...\ngemini-4-hydrogen-xhigh\tHydrogen (XHigh)\ngemini-4-hydrogen-low\tHydrogen (Low)\ngemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)')).toEqual([
      { id: 'gemini-4-hydrogen', label: 'Hydrogen', effort: 'xhigh' },
      { id: 'gemini-4-hydrogen', label: 'Hydrogen', effort: 'low' },
      { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)' },
    ])
    expect(mergeAgyModels([
      { id: 'other-model', label: 'Other', effort: 'max' },
    ]).find(option => option.id === 'other-model')).toMatchObject({ label: 'Other', efforts: [] })
  })

  it.each(['', 'Fetching available models...', 'garbage', 'id-low\t'])('rejects empty or unexpected output: %s', output => {
    expect(() => parseAgyModels(output)).toThrow()
  })
})

describe('agy model-list process', () => {
  it('reports missing CLIs as list failures without throwing to the caller', async () => {
    expect(await loadAgyModels({ path: '/not-installed/agy', refresh: true })).toMatchObject({ source: 'builtin', problem: 'unavailable' })
    expect(await loadPorchProfiles({ porchPath: '/not-installed/porch', refresh: true })).toMatchObject({ source: 'builtin', problem: 'unavailable' })
  })

  it('scrubs both provider keys from the child environment and reports garbage output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yogurt-agy-options-'))
    const path = join(root, 'agy'), dump = join(root, 'env.json')
    try {
      await writeFile(path, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(process.env.DUMP_PATH, JSON.stringify({gemini:process.env.GEMINI_API_KEY, openrouter:process.env.YOGURT_OPENROUTER_API_KEY})); console.log('garbage');\n`, { mode: 0o700 })
      await chmod(path, 0o700)
      vi.stubEnv('DUMP_PATH', dump)
      vi.stubEnv('GEMINI_API_KEY', 'fake-gemini-key')
      vi.stubEnv('YOGURT_OPENROUTER_API_KEY', 'fake-openrouter-key')
      const result = await loadAgyModels({ path, refresh: true })
      expect(result).toMatchObject({ source: 'builtin', problem: 'unavailable' })
      const child = JSON.parse(readFileSync(dump, 'utf8'))
      expect(child).toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('turns a failing CLI into the built-in list error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yogurt-agy-options-'))
    const path = join(root, 'agy')
    try {
      await writeFile(path, `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o700 }); await chmod(path, 0o700)
      expect(await loadAgyModels({ path, refresh: true })).toMatchObject({ source: 'builtin', problem: 'unavailable' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('times out a slow CLI after five seconds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yogurt-agy-options-'))
    const path = join(root, 'agy')
    try {
      await writeFile(path, `#!${process.execPath}\nsetTimeout(() => console.log('too late'), 10000);\n`, { mode: 0o700 }); await chmod(path, 0o700)
      expect(await loadAgyModels({ path, refresh: true })).toMatchObject({ source: 'builtin', problem: 'unavailable' })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 12000)
})
