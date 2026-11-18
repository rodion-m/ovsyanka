/** OpenRouter developer credentials are never passed to subprocesses. */
export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  delete env.OPENROUTER_API_KEY
  delete env.YOGURT_OPENROUTER_API_KEY
  return env
}
