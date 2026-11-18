import { describe, expect, it, vi } from 'vitest'

const { openRouterOptions } = vi.hoisted(() => ({ openRouterOptions: vi.fn() }))
vi.mock('../src/main/harness/openrouterModels', () => ({ openRouterOptions }))
import { getAiOptions } from '../src/main/harness/aiOptions'

describe('ai:options provider routing', () => {
  it('routes OpenRouter option requests, including refresh, to its cache-first catalog', async () => {
    const options = { transcription: [], text: [], source: 'cache' }
    openRouterOptions.mockResolvedValueOnce(options)
    await expect(getAiOptions({ backend: 'openrouter', refresh: true })).resolves.toBe(options)
    expect(openRouterOptions).toHaveBeenCalledWith({ refresh: true })
  })
})
