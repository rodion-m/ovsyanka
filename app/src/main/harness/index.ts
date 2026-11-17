import type { AiCheck, AiSettings } from '../../shared/ai'
import { createAgy } from './agy'
import { agyStoreRoot, forgetJournalPath, processForgetJournal } from './agyStore'
import { createHarnessModel } from './model'
import { createPorch, exactProfile, porchInstallation, PORCH_CONTRACT } from './porch'
import { executablePath, HarnessError, HarnessProcesses } from './process'
import { createHarnessTranscriber, TRANSCRIPT_SCHEMA } from './transcribe'

export function createSubscriptionHarness({ settings, tempDir, storeRoot = agyStoreRoot() }: { settings: AiSettings; tempDir: string; storeRoot?: string }) {
  if (settings.backend === 'local') throw new HarnessError('Local models use Yogurt\'s existing local engine.')
  const selected = { ...settings }
  if (selected.backend === 'porch') { exactProfile(selected.textProfile); exactProfile(selected.transcriptionProfile) }
  const processes = new HarnessProcesses()
  const journalPath = forgetJournalPath(tempDir)
  // A quit or crash mid-request leaves journal entries; replay them under the same ownership rule.
  void processForgetJournal(journalPath, storeRoot)
    .catch(error => console.warn('Yogurt could not replay pending agy conversation cleanup.', error))
  const agy = createAgy(selected, processes, { storeRoot, journalPath })
  const porch = createPorch(selected, processes)
  const common = { settings: selected, tempDir, signal: processes.signal }
  return {
    model: createHarnessModel({ ...common, complete: selected.backend === 'porch' ? porch.text
      : (prompt, directory, signal) => agy({ prompt, directory, signal }) }),
    transcriber(callbacks: Parameters<typeof createHarnessTranscriber>[1]) {
      return createHarnessTranscriber({ ...common, transcribe: request => selected.backend === 'porch'
        ? porch.transcribe(request.prompt, request.directory, request.signal)
        : agy({ prompt: request.prompt, directory: request.directory, signal: request.signal, audio: true, schema: TRANSCRIPT_SCHEMA }) }, callbacks)
    },
    stop: () => processes.stop(),
  }
}

/** Installation-only check. No login, model listing, inference, or audio leaves the computer. */
export async function checkHarness(settings: AiSettings): Promise<AiCheck> {
  if (settings.backend === 'local') return { ok: true, message: 'Local models use Yogurt\'s existing setup.' }
  const processes = new HarnessProcesses()
  const version = async (path: string, label: string, args: string[]) => {
    const executable = await executablePath(path, label)
    const result = await processes.run({ label, executable, args, timeoutMs: 5000, stdoutLimit: 128 * 1024, stderrLimit: 128 * 1024 })
    return { executable, output: result.stdout || result.stderr }
  }
  try {
    if (settings.backend === 'porch') { exactProfile(settings.textProfile); exactProfile(settings.transcriptionProfile); await porchInstallation(settings.porchPath) }
    const agy = await version(settings.agyPath, 'Antigravity CLI (agy)', ['--version'])
    const match = agy.output.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
    if (!match) throw new HarnessError('Could not determine the agy version. Install Antigravity CLI 1.5.4 or newer.')
    const [major, minor, patch] = match.slice(1).map(Number)
    if (major < 1 || (major === 1 && (minor < 5 || (minor === 5 && patch < 4)))) throw new HarnessError('Antigravity CLI 1.5.4 or newer is required for native audio and stream-json input.')
    if (settings.backend === 'porch') {
      await Promise.all([
        version('bash', 'Bash', ['--version']), version('python3', 'Python 3', ['--version']),
      ])
      return { ok: true, message: `Porch's raw adapter, Bash and Python 3 are installed (contract ${PORCH_CONTRACT.slice(0, 7)}; agy ${match[0]} at ${agy.executable}). Profiles keep their own permissions; Yogurt removes provider API keys and inherited model/effort overrides, so each profile must work through its CLI's subscription sign-in. Authentication and model access have not been tested.` }
    }
    return { ok: true, message: `Antigravity CLI ${match[0]} is installed at ${agy.executable}. Sign in with your Google account by running agy in a terminal. Authentication and model access have not been tested.` }
  } catch (error) {
    return { ok: false, message: error instanceof HarnessError ? error.message : 'Could not check the AI harness installation. Verify the executable paths.' }
  } finally { processes.stop() }
}
