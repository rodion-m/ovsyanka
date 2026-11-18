import { loadAgyModels } from './agyModels'
import { loadPorchProfiles } from './porchProfiles'

export type AiOptionsRequest = { backend: 'agy' | 'porch'; refresh?: boolean; agyPath?: string; porchPath?: string }

/** The agy and Porch routes used by ai:options; OpenRouter is added by its adapter stage. */
export function getAiOptions(request: AiOptionsRequest) {
  return request.backend === 'agy'
    ? loadAgyModels({ path: request.agyPath, refresh: request.refresh })
    : loadPorchProfiles({ porchPath: request.porchPath, agyPath: request.agyPath, refresh: request.refresh })
}
