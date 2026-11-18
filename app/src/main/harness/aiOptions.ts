import { loadAgyModels } from './agyModels'
import { loadPorchProfiles } from './porchProfiles'
import { openRouterOptions } from './openrouterModels'

export type AiOptionsRequest = { backend: 'agy' | 'porch' | 'openrouter'; refresh?: boolean; agyPath?: string; porchPath?: string }

/** Route options to the provider-specific cache. */
export function getAiOptions(request: AiOptionsRequest) {
  return request.backend === 'openrouter' ? openRouterOptions({ refresh: request.refresh }) : request.backend === 'agy'
    ? loadAgyModels({ path: request.agyPath, refresh: request.refresh })
    : loadPorchProfiles({ porchPath: request.porchPath, agyPath: request.agyPath, refresh: request.refresh })
}
