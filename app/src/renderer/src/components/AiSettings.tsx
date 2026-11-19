import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { DEFAULT_AI_SETTINGS, validAiSettings, type AiBackend, type AiCheck, type AiEffort, type AiOutputLanguage, type AiPreferences, type AiSettings as Configuration } from '../../../shared/ai'
import { agyTextOptions, agyTranscriptionOptions, sortAiOptions, validCustomId, type AiOption, type AiOptions, type AiSortMode } from '../../../shared/aiCatalog'
import { useLanguage } from '../i18n'
import { language } from '../../../shared/i18n'
import { aiText, aiTextF, type AiCopyKey } from './aiCopy'
import { aiProblemText } from './aiCopy'
import { ModelPicker, type ModelPickerGroup } from './ModelPicker'
import './AiSettings.css'

const backendName = (backend: AiBackend) => aiText(backend as AiCopyKey)
const same = (a: Configuration, b: Configuration) => JSON.stringify(a) === JSON.stringify(b)
/** The status line's one-line summary of a configuration: mode plus what transcribes. */
const summary = (s: Configuration) => backendName(s.backend) + (s.backend === 'local' ? '' : ` · ${s.backend === 'porch' ? s.transcriptionProfile : s.backend === 'openrouter' ? s.openrouterTranscriptionModel : s.transcriptionModel}`)
export const formatCatalogTime = (timestamp: number, locale = language()) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp)
const lock = (locked: AiPreferences['locked'], key: string) => (locked as Record<string, { variable: string; value: string }> | undefined)?.[key]
const lockHelp = (locked: AiPreferences['locked'], key: string) => {
  const field = lock(locked, key)
  return field ? aiTextF('lockedByEnv', { VAR: field.variable }) : undefined
}
/** A field fixed by a launch variable reads as the effective value; the draft keeps the saved one underneath. */
const effective = (value: Configuration, locked: AiPreferences['locked']): Configuration => ({
  ...value,
  ...(locked?.backend ? { backend: locked.backend.value as AiBackend } : {}),
  ...(locked?.agyPath ? { agyPath: locked.agyPath.value } : {}),
  ...(locked?.porchPath ? { porchPath: locked.porchPath.value } : {}),
})

const groupCopy: Record<AiOption['group'], AiCopyKey> = {
  recommended: 'groupRecommended', audio: 'groupAudio', stt: 'groupStt', text: 'groupText',
  free: 'groupFree', alias: 'groupText', unavailable: 'groupUnavailable',
}
const pickerGroups = (ids: readonly AiOption['group'][]): ModelPickerGroup[] => ids.map(id => ({ id, label: aiText(groupCopy[id]) }))
const porchBackendName = (backend: string) => ({
  'antigravity-cli': 'Antigravity', 'claude-code': 'Claude Code', 'codex-cli': 'Codex', 'grok-cli': 'Grok', 'opencode-cli': 'OpenCode',
} as Record<string, string>)[backend] ?? backend
const porchTextGroups = (options: readonly AiOption[]): ModelPickerGroup[] => [
  ...[...new Set(options.filter(option => option.group === 'text').map(option => option.vendor).filter((vendor): vendor is string => !!vendor))]
    .map(vendor => ({ id: 'text' as const, vendor, label: porchBackendName(vendor) })),
  { id: 'unavailable', label: aiText('groupUnavailable') },
]
const effortsOf = (options: readonly AiOption[], modelId: string, fallback: AiEffort[]): AiEffort[] => {
  const efforts = options.find(option => option.id === modelId)?.efforts
  return efforts?.length ? efforts : fallback
}
const withoutLow = (levels: readonly AiEffort[], fallback: AiEffort[]): AiEffort[] => {
  const result = levels.filter(level => level !== 'low')
  return result.length ? result : fallback
}
const AGY_TRANSCRIPTION = agyTranscriptionOptions()
const AGY_TEXT = agyTextOptions()
const AGY_BUILTIN_OPTIONS: AiOptions = { transcription: AGY_TRANSCRIPTION, text: AGY_TEXT, source: 'builtin' }

function Row({ id, label, help, children, className }: { id: string; label: string; help?: string; children: ReactNode; className?: string }) {
  return <div className={`settings-row${className ? ` ${className}` : ''}`}>
    <div className="settings-row-copy"><label htmlFor={id} className="settings-label">{label}</label>
      {help && <p id={`${id}-help`} className="settings-description">{help}</p>}</div>
    {children}
  </div>
}

/** Kept separate so the backend-specific fields can be checked without starting Electron. */
export function AiSettingsFields({ value, change, locked }: { value: Configuration; change(patch: Partial<Configuration>): void; locked?: AiPreferences['locked'] }) {
  // a field fixed by a launch variable shows the effective value, disabled, naming the variable; the saved value stays underneath
  const shown = effective(value, locked)
  const [catalog, setCatalog] = useState<AiOptions>(shown.backend === 'porch' ? { transcription: [], text: [], source: 'builtin' } : AGY_BUILTIN_OPTIONS)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const refreshCatalog = async () => {
    setCatalogBusy(true)
    try { setCatalog(await window.yogurt.ai.options({ backend: shown.backend === 'openrouter' ? 'openrouter' : shown.backend === 'porch' ? 'porch' : 'agy', refresh: true, agyPath: shown.agyPath, porchPath: shown.porchPath })) }
    catch { setCatalog(shown.backend === 'porch' || shown.backend === 'openrouter' ? { transcription: [], text: [], source: 'builtin', problem: 'unavailable' } : { ...AGY_BUILTIN_OPTIONS, problem: 'unavailable' }) }
    finally { setCatalogBusy(false) }
  }
  useEffect(() => {
    if (shown.backend === 'openrouter') {
      setCatalogBusy(true)
      void window.yogurt.ai.options({ backend: 'openrouter' }).then(setCatalog)
        .catch(() => setCatalog({ transcription: [], text: [], source: 'builtin', problem: 'unavailable' }))
        .finally(() => setCatalogBusy(false))
    } else if (shown.backend === 'porch') {
      setCatalog({ transcription: [], text: [], source: 'builtin' })
      setCatalogBusy(true)
      void window.yogurt.ai.options({ backend: 'porch', agyPath: shown.agyPath, porchPath: shown.porchPath })
        .then(setCatalog).catch(() => setCatalog({ transcription: [], text: [], source: 'builtin', problem: 'unavailable' }))
        .finally(() => setCatalogBusy(false))
    } else setCatalog(AGY_BUILTIN_OPTIONS)
  }, [shown.backend, shown.agyPath, shown.porchPath])
  const input = (key: 'agyPath' | 'porchPath' | 'transcriptionModel' | 'textModel' | 'transcriptionProfile' | 'textProfile', label: AiCopyKey, help?: AiCopyKey) => {
    const id = `ai-${key}`
    const helpText = lockHelp(locked, key) ?? (help && aiText(help))
    return <Row key={key} id={id} label={aiText(label)} help={helpText}>
      <input id={id} data-testid={id} className="settings-name-field" value={shown[key]} required disabled={!!lock(locked, key)}
        maxLength={key.endsWith('Path') ? 4096 : 200} spellCheck={false} autoComplete="off"
        aria-describedby={helpText ? `${id}-help` : undefined}
        onChange={e => change({ [key]: e.target.value })} onBlur={e => change({ [key]: e.target.value.trim() })} />
    </Row>
  }
  const select = (id: string, label: string, current: string, options: Array<[string, string]>, choose: (v: string) => void, help?: string, disabled = false) =>
    <Row id={id} label={label} help={help}><span className="settings-select-wrap">
      <select id={id} data-testid={id} className="settings-select" value={current} disabled={disabled} aria-describedby={help ? `${id}-help` : undefined} onChange={e => choose(e.target.value)}>
        {options.map(([v, title]) => <option key={v} value={v}>{title}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </span></Row>
  const effort = (key: 'transcriptionEffort' | 'textEffort', label: AiCopyKey, options: readonly AiEffort[] = ['low', 'medium', 'high']) =>
    select(`ai-${key}`, aiText(label), shown[key], options.map(v => [v, aiText(v)]), v => change({ [key]: v as AiEffort }))
  // Changing the model narrows the effort select to the new model's levels; an unsupported saved level falls back to medium.
  const pickModel = (key: 'transcriptionModel' | 'textModel', options: readonly AiOption[], fallback: AiEffort[]) => (id: string) => {
    let levels = effortsOf(options, id, fallback)
    if (key === 'transcriptionModel') levels = withoutLow(levels, fallback)
    const effortKey = key === 'transcriptionModel' ? 'transcriptionEffort' : 'textEffort' as const
    const patch: Partial<Configuration> = { [key]: id }
    if (!levels.includes(shown[effortKey])) patch[effortKey] = levels.includes('medium') ? 'medium' : levels[0]
    change(patch)
  }
  const picker = (key: 'transcriptionModel' | 'textModel', label: AiCopyKey, options: readonly AiOption[], groups: readonly AiOption['group'][], help: AiCopyKey | undefined, fallback: AiEffort[]) => {
    const id = `ai-${key}`
    const helpText = lockHelp(locked, key) ?? (help && aiText(help))
    return <Row key={key} id={id} label={aiText(label)} help={helpText}>
      <ModelPicker id={id} value={shown[key]} options={options} groups={pickerGroups(groups)} locked={!!lock(locked, key)}
        hideAudioHint={key === 'textModel'}
        state={catalogBusy ? { status: 'loading' } : catalog.problem ? { status: 'error', message: aiText('agyListFailed'), onRetry: () => void refreshCatalog(), keepOptions: true } : { status: 'ready' }}
        toolbar={<button type="button" className="model-picker-retry" aria-label={aiText('refreshList')} title={aiText('refreshList')} disabled={catalogBusy} onMouseDown={e => e.preventDefault()} onClick={() => void refreshCatalog()}><RefreshCw size={14} aria-hidden="true" /></button>}
        describedBy={helpText ? `${id}-help` : undefined} allowCustom validateCustom={validCustomId}
        onChange={pickModel(key, options, fallback)} />
    </Row>
  }
  return <>
    {select('ai-backend', aiText('backend'), shown.backend, [...(['agy', 'porch', 'openrouter', 'local'] as const).map(v => [v, backendName(v)] as [string, string])], v => change({ backend: v as AiBackend }), lockHelp(locked, 'backend'), !!lock(locked, 'backend'))}
    <p className="ai-settings-note" data-testid="ai-mode-description">{aiText(shown.backend === 'local' ? 'localHelp' : shown.backend === 'openrouter' ? 'openrouterHelp' : 'subscription')}</p>
    {shown.backend !== 'local' && <>
      {shown.backend === 'agy' && <p className="ai-settings-note">{aiText('defaultModel')}</p>}
      {shown.backend === 'porch' && <>
        <Row id="ai-transcriptionProfile" label={aiText('audioProfile')} help={aiText('audioProfileHelp')}>
          <ModelPicker id="ai-transcriptionProfile" value={shown.transcriptionProfile} defaultValue={DEFAULT_AI_SETTINGS.transcriptionProfile} options={catalog.transcription} groups={[{ id: 'audio', label: aiText('porchTranscriptionGroup') }, ...pickerGroups(['unavailable'])]}
            allowCustom validateCustom={id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)} onChange={id => {
              const selected = catalog.transcription.find(option => option.id === id)
              const profileModel = selected?.detail?.split(' · ').at(-1)
              change({ transcriptionProfile: id, ...(profileModel ? { transcriptionModel: profileModel } : {}) })
            }} state={catalogBusy ? { status: 'loading' } : catalog.problem ? { status: 'error', message: aiText('porchListFailed'), onRetry: () => void refreshCatalog() } : { status: 'ready' }}
            toolbar={<button type="button" className="model-picker-retry" aria-label={aiText('refreshList')} title={aiText('refreshList')} disabled={catalogBusy} onMouseDown={e => e.preventDefault()} onClick={() => void refreshCatalog()}><RefreshCw size={14} aria-hidden="true" /></button>} />
        </Row>
        <Row id="ai-textProfile" label={aiText('textProfile')} help={aiText('textProfileHelp')}>
          <ModelPicker id="ai-textProfile" value={shown.textProfile} defaultValue={DEFAULT_AI_SETTINGS.textProfile} options={catalog.text} groups={porchTextGroups(catalog.text)} allowCustom showErrorWhenClosed
            validateCustom={id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)} onChange={id => change({ textProfile: id })}
            state={catalogBusy ? { status: 'loading' } : catalog.problem ? { status: 'error', message: aiText('porchListFailed'), onRetry: () => void refreshCatalog() } : { status: 'ready' }}
            toolbar={<button type="button" className="model-picker-retry" aria-label={aiText('refreshList')} title={aiText('refreshList')} disabled={catalogBusy} onMouseDown={e => e.preventDefault()} onClick={() => void refreshCatalog()}><RefreshCw size={14} aria-hidden="true" /></button>} />
        </Row>
        <p className="ai-settings-note">{aiText('porchTextNote')}</p>
      </>}
    {shown.backend === 'openrouter' && <OpenRouterFields value={shown} change={change} locked={locked?.openrouterKey} catalog={catalog} busy={catalogBusy} refresh={() => void refreshCatalog()} />}
      {shown.backend === 'agy'
        ? picker('transcriptionModel', 'audioModel', catalog.transcription, ['recommended', 'audio'], undefined, ['medium', 'high'])
        : shown.backend === 'porch' || shown.backend === 'openrouter' ? null : input('transcriptionModel', 'audioModel')}
      {shown.backend !== 'openrouter' && effort('transcriptionEffort', 'audioEffort', shown.backend === 'agy' ? withoutLow(effortsOf(AGY_TRANSCRIPTION, shown.transcriptionModel, ['medium', 'high']), ['medium', 'high']) : ['medium', 'high'])}
      {shown.backend === 'agy' && <>
        {picker('textModel', 'textModel', catalog.text, ['recommended', 'text'], 'textHelp', ['low', 'medium', 'high'])}
        {effort('textEffort', 'textEffort', effortsOf(catalog.text, shown.textModel, ['low', 'medium', 'high']))}
      </>}
    </>}
    {shown.backend !== 'local' && select('ai-outputLanguage', aiText('outputLanguage'), shown.outputLanguage, [['auto', aiText('auto')], ['ru', aiText('russian')], ['en', aiText('english')]], v => change({ outputLanguage: v as AiOutputLanguage }), aiText('outputHelp'))}
    {shown.backend !== 'local' && <details className="ai-settings-advanced" data-testid="ai-advanced">
      <summary>{aiText('advanced')}</summary>
      {input('agyPath', 'agyPath', 'pathHelp')}
      {shown.backend === 'porch' && input('porchPath', 'porchPath', 'pathHelp')}
      {shown.backend === 'porch' && input('transcriptionModel', 'transcriptionOverride', 'transcriptionOverrideHelp')}
      {(['timeoutSeconds', 'contextTokens'] as const).map(key => {
        const id = `ai-${key}`
        return <Row key={key} id={id} label={aiText(key === 'timeoutSeconds' ? 'timeout' : 'context')}>
          <input id={id} data-testid={id} className="settings-name-field" type="number" step={1} required
            min={key === 'timeoutSeconds' ? 10 : 8192} max={key === 'timeoutSeconds' ? 1800 : 1_048_576}
            value={Number.isFinite(value[key]) ? value[key] : ''} aria-describedby="ai-limits-help"
            onChange={e => change({ [key]: e.target.value === '' ? Number.NaN : Number(e.target.value) })} />
        </Row>
      })}
      <p id="ai-limits-help" className="ai-settings-note">{aiText('limitsHelp')}</p>
    </details>}
  </>
}

/** OpenRouter credentials are read straight from the input and the input is cleared before awaiting IPC. */
function OpenRouterFields({ value, change, locked, catalog, busy, refresh }: { value: Configuration; change(patch: Partial<Configuration>): void; locked?: NonNullable<AiPreferences['locked']>['openrouterKey']; catalog: AiOptions; busy: boolean; refresh(): void }) {
  const keyInput = useRef<HTMLInputElement>(null)
  const [keyStatus, setKeyStatus] = useState<import('../../../shared/ai').AiKeyStatus>()
  const [editingKey, setEditingKey] = useState(false)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState(false)
  const [sort, setSort] = useState<AiSortMode>('newest')
  const [usage, setUsage] = useState<import('../../../shared/ai').AiUsage>()
  const [usageUnknown, setUsageUnknown] = useState(false)
  const [probeBusy, setProbeBusy] = useState<'text' | 'transcription' | null>(null)
  const [probeResults, setProbeResults] = useState<Partial<Record<'text' | 'transcription', import('../../../shared/ai').AiProbeResult>>>({})
  useEffect(() => {
    let active = true
    void window.yogurt.ai.openrouter.keyStatus().then(status => { if (active) setKeyStatus(status) }).catch(() => { if (active) setKeyStatus({ state: 'unavailable' }) })
    void window.yogurt.ai.openrouter.usage().then(summary => { if (active) setUsage(summary) }).catch(() => { if (active) setUsageUnknown(true) })
    return () => { active = false }
  }, [])
  const saveKey = async () => {
    const input = keyInput.current
    if (!input || !input.value) return
    const pastedKey = input.value
    input.value = ''
    setKeyBusy(true); setKeyError(false)
    try { const status = await window.yogurt.ai.openrouter.setKey(pastedKey); setKeyStatus(status); setKeyError(status.state !== 'ok' && status.state !== 'unchecked'); if (status.state === 'ok' || status.state === 'unchecked') setEditingKey(false) }
    catch { setKeyError(true) }
    finally { setKeyBusy(false) }
  }
  const checkKey = async () => {
    setKeyBusy(true); setKeyError(false)
    try { const status = await window.yogurt.ai.openrouter.checkKey(); setKeyStatus(status); setKeyError(status.state !== 'ok') }
    catch { setKeyError(true) }
    finally { setKeyBusy(false) }
  }
  const removeKey = async () => {
    setKeyBusy(true)
    try { setKeyStatus(await window.yogurt.ai.openrouter.clearKey()); setEditingKey(false) }
    catch { setKeyError(true) }
    finally { setKeyBusy(false) }
  }
  const probe = async (task: 'text' | 'transcription') => {
    setProbeBusy(task)
    try { const result = await window.yogurt.ai.openrouter.probe(value, task); setProbeResults(previous => ({ ...previous, [task]: result })) }
    catch { setProbeResults(previous => ({ ...previous, [task]: { ok: false, elapsedMs: 0, message: aiText('checkFailed') } })) }
    finally { setProbeBusy(null) }
  }
  const probeButton = (task: 'text' | 'transcription') => <button type="button" className="workspace-button" disabled={keyStatus?.state !== 'ok' || probeBusy !== null} onClick={() => void probe(task)}>{aiText(probeBusy === task ? 'testing' : 'test')}</button>
  const probeResult = (task: 'text' | 'transcription') => {
    const result = probeResults[task]
    return result && <p className="ai-settings-status" role={result.ok ? 'status' : 'alert'} data-error={!result.ok}>
      {aiText(result.ok ? 'testPassed' : 'checkFailed')} · {(result.elapsedMs / 1000).toFixed(1)}s{result.costUsd === undefined ? '' : ` · $${result.costUsd.toFixed(4)}`}
      {result.message && <span className="ai-settings-result">{result.message}</span>}
    </p>
  }
  const audioAll = catalog.transcription.map(option => ({
    ...option,
    hints: option.hints.includes('experimental') ? option.hints : [...option.hints, 'experimental' as const],
  }))
  const audioOptions = sortAiOptions(audioAll, sort)
  const textOptions = sortAiOptions(catalog.text, sort)
  const audioOption = audioAll.find(option => option.id === value.openrouterTranscriptionModel)
  const keyLast4 = keyStatus && 'last4' in keyStatus ? keyStatus.last4 : ''
  const audioMissing = catalog.source === 'live' && !!catalog.fetchedAt && !audioAll.some(option => option.id === value.openrouterTranscriptionModel)
  const textMissing = catalog.source === 'live' && !!catalog.fetchedAt && !textOptions.some(option => option.id === value.openrouterTextModel)
  const sttOnly = value.openrouterTranscriptionKind === 'stt' || audioOption?.group === 'stt' || (audioOption && audioOption.kind === 'stt')
  const sameModel = !sttOnly && value.openrouterTranscriptionKind === 'chat' && value.openrouterTranscriptionModel === value.openrouterTextModel
  const groups = pickerGroups(['recommended', 'audio', 'stt', 'free'])
  const updated = catalog.fetchedAt ? formatCatalogTime(catalog.fetchedAt) : undefined
  return <div className="openrouter-fields" data-testid="openrouter-fields">
    <Row id="ai-openrouter-key" label={aiText('keyLabel')} help={locked ? aiTextF('lockedByEnv', { VAR: locked.variable }) : aiText('keyStored')} className="openrouter-key-row">
      <div className="openrouter-key-controls">
        {locked ? <input key="locked-key" id="ai-openrouter-key" className="settings-name-field" value={`sk-or-v1-••••••••${keyLast4}`} readOnly aria-describedby="ai-openrouter-key-help" />
          : editingKey || !keyStatus || keyStatus.state === 'none' || keyStatus.state === 'unreadable' || keyStatus.state === 'unavailable'
            ? <input key="paste-key" id="ai-openrouter-key" data-testid="ai-openrouter-key" ref={keyInput} className="settings-name-field" type="text" autoComplete="off" spellCheck={false} placeholder={aiText('keyPaste')} onKeyDown={event => { if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'v') event.preventDefault() }} onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData('text'); if (keyInput.current) { keyInput.current.value = text; keyInput.current.focus(); void saveKey() } }} />
            : <input key="masked-key" id="ai-openrouter-key" className="settings-name-field" value={`sk-or-v1-••••••••${keyLast4}`} readOnly aria-describedby="ai-openrouter-key-help" />}
        <div className="openrouter-key-buttons">
          {locked ? <button type="button" className="workspace-button" disabled={keyBusy} onClick={() => void checkKey()}>{aiText(keyBusy ? 'testing' : 'keyCheck')}</button>
            : !keyStatus || keyStatus.state === 'none' || keyStatus.state === 'unreadable' || keyStatus.state === 'unavailable' || editingKey
              ? <button type="button" className="workspace-button" disabled={keyBusy} onClick={() => void saveKey()}>{aiText(keyBusy ? 'testing' : 'keySaveCheck')}</button>
              : <><button type="button" className="workspace-button" disabled={keyBusy} onClick={() => void checkKey()}>{aiText(keyBusy ? 'testing' : 'keyCheck')}</button><button type="button" className="workspace-button" disabled={keyBusy} onClick={() => { setEditingKey(true); setTimeout(() => keyInput.current?.focus(), 0) }}>{aiText('keyReplace')}</button><button type="button" className="workspace-button" disabled={keyBusy} onClick={() => void removeKey()}>{aiText('keyRemove')}</button></>}
        </div>
        {!locked && <a className="openrouter-key-link" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">{aiText('keyGet')}</a>}
      </div>
    </Row>
    <p className="ai-settings-note">{keyStatus?.state === 'ok' ? `${typeof keyStatus.remainingUsd === 'number' ? aiTextF('keyOk', { label: keyStatus.label || 'OpenRouter', x: keyStatus.remainingUsd.toFixed(2) }) : `${aiText('keyWorks')}${keyStatus.label ? ` · “${keyStatus.label}”` : ''}${keyStatus.remainingUsd === null ? ` · ${aiText('keyNoLimit')}` : ''}`}` : keyError || keyStatus?.state === 'rejected' ? aiText('keyInvalid') : keyStatus?.state === 'unavailable' ? aiText('keychainUnavailable') : keyStatus?.state === 'unreadable' ? aiText('keyUnreadable') : aiText('keyAdvice')}</p>
    {keyStatus?.state === 'ok' && <p className="ai-settings-note">{aiText('keyAdvice')}</p>}
    <Row id="ai-openrouter-transcriptionModel" label={aiText('audioModel')}>
      <div className="openrouter-model-controls"><ModelPicker id="ai-openrouter-transcriptionModel" value={value.openrouterTranscriptionModel} options={audioOptions} groups={groups} allowCustom showErrorWhenClosed validateCustom={validCustomId} hint={audioMissing ? aiTextF('modelMissing', { model: value.openrouterTranscriptionModel }) : undefined} state={busy ? { status: 'loading' } : catalog.problem ? { status: catalog.source === 'cache' ? 'cache' : 'empty', fetchedAt: catalog.fetchedAt, onRetry: refresh } : { status: 'ready' }} onChange={id => { const picked = audioAll.find(option => option.id === id); const kind = picked?.group === 'stt' || picked?.kind === 'stt' ? 'stt' : 'chat'; change({ openrouterTranscriptionModel: id, openrouterTranscriptionKind: kind, ...(kind === 'chat' && sameModel ? { openrouterTextModel: id } : {}) }) }} toolbar={<div className="openrouter-picker-toolbar"><button type="button" aria-pressed={sort === 'newest'} onClick={() => setSort('newest')}>{aiText('sortNewest')}</button><button type="button" aria-pressed={sort === 'cheapest'} onClick={() => setSort('cheapest')}>{aiText('sortCheapest')}</button><span>{updated ? aiTextF('listUpdated', { when: updated }) : ''}</span><button type="button" aria-label={aiText('refresh')} disabled={busy} onClick={refresh}>⟳</button></div>} />
        <>{probeButton('transcription')}<span className="openrouter-probe-help">{aiText('testQuota')}</span></>
      </div>
    </Row>
    {probeResult('transcription')}
    <Row id="ai-openrouter-transcriptionEffort" label={aiText('audioEffort')}><span className="settings-select-wrap"><select id="ai-openrouter-transcriptionEffort" data-testid="ai-openrouter-transcriptionEffort" className="settings-select" value={value.transcriptionEffort} onChange={event => change({ transcriptionEffort: event.target.value as AiEffort })}><option value="medium">{aiText('medium')}</option><option value="high">{aiText('high')}</option></select><ChevronDown size={14} aria-hidden="true" /></span></Row>
    <label className="openrouter-same"><span>{aiText('sameModel')}</span><input type="checkbox" checked={sameModel} disabled={!!sttOnly} aria-describedby={sttOnly ? 'ai-openrouter-stt-only' : undefined} onChange={event => change({ openrouterTextModel: event.target.checked ? value.openrouterTranscriptionModel : (textOptions.find(option => option.id !== value.openrouterTranscriptionModel)?.id ?? 'openai/gpt-4o-mini') })} /></label>
    {sttOnly && <p id="ai-openrouter-stt-only" className="ai-settings-note">{aiText('sttOnly')}</p>}
    <Row id="ai-openrouter-textModel" label={aiText('textModel')}>
      <div className="openrouter-model-controls"><ModelPicker id="ai-openrouter-textModel" value={value.openrouterTextModel} options={textOptions} groups={pickerGroups(['recommended', 'text', 'free'])} hideAudioHint allowCustom showErrorWhenClosed validateCustom={validCustomId} hint={textMissing ? aiTextF('modelMissing', { model: value.openrouterTextModel }) : undefined} state={busy ? { status: 'loading' } : catalog.problem ? { status: catalog.source === 'cache' ? 'cache' : 'empty', fetchedAt: catalog.fetchedAt, onRetry: refresh } : { status: 'ready' }} onChange={id => change({ openrouterTextModel: id })} toolbar={<div className="openrouter-picker-toolbar"><button type="button" aria-pressed={sort === 'newest'} onClick={() => setSort('newest')}>{aiText('sortNewest')}</button><button type="button" aria-pressed={sort === 'cheapest'} onClick={() => setSort('cheapest')}>{aiText('sortCheapest')}</button><span>{updated ? aiTextF('listUpdated', { when: updated }) : ''}</span><button type="button" aria-label={aiText('refresh')} disabled={busy} onClick={refresh}>⟳</button></div>} />
        {probeButton('text')}
      </div>
    </Row>
    {probeResult('text')}
    <Row id="ai-openrouter-textEffort" label={aiText('textEffort')}><span className="settings-select-wrap"><select id="ai-openrouter-textEffort" data-testid="ai-openrouter-textEffort" className="settings-select" value={value.textEffort} onChange={event => change({ textEffort: event.target.value as AiEffort })}><option value="low">{aiText('low')}</option><option value="medium">{aiText('medium')}</option><option value="high">{aiText('high')}</option></select><ChevronDown size={14} aria-hidden="true" /></span></Row>
    {selectOpenRouterPolicy(value, change)}
    {usage && <p className="ai-settings-note" data-testid="openrouter-usage">{aiTextF('spend', { a: usage.todayUsd.toFixed(2), b: usage.thirtyDayUsd.toFixed(2) })}</p>}
    {(usageUnknown || usage?.transcriptionCostUnknown || usage?.textCostUnknown || (usage?.missingCostCount ?? 0) > 0) && <p className="ai-settings-note">{aiText('spendUnknown')}</p>}
  </div>
}

function selectOpenRouterPolicy(value: Configuration, change: (patch: Partial<Configuration>) => void) {
  return <Row id="ai-openrouter-dataPolicy" label={aiText('dataPolicy')} help={aiText('dataHelp')}><span className="settings-select-wrap"><select id="ai-openrouter-dataPolicy" data-testid="ai-openrouter-dataPolicy" className="settings-select" value={value.openrouterDataPolicy} onChange={event => change({ openrouterDataPolicy: event.target.value as Configuration['openrouterDataPolicy'] })}><option value="deny">{aiText('dataDeny')}</option><option value="zdr">{aiText('dataZdr')}</option><option value="any">{aiText('dataAny')}</option></select><ChevronDown size={14} aria-hidden="true" /></span></Row>
}

/** One line for what runs now; a second line only while different saved settings wait for a restart no launch variable blocks. */
export function AiStatus({ preferences, busy, dirty, restart }: { preferences: AiPreferences; busy: 'save' | 'check' | 'restart' | null; dirty: boolean; restart(): void }) {
  const { active, saved, restartRequired, locked } = preferences
  const hasLocks = !!locked && Object.keys(locked).length > 0
  return <p className="ai-settings-note" data-testid="ai-active" role="status">
    <strong>{aiText('activeNow')}:</strong> {summary(active)}
    {restartRequired && !hasLocks && <span className="ai-settings-result ai-settings-pending" data-testid="ai-saved-pending">
      <span>{aiTextF('savedPending', { x: summary(saved) })}</span>
      <button type="button" data-testid="ai-restart" className="workspace-button" disabled={!!busy || dirty} onClick={restart}>{aiText(busy === 'restart' ? 'restarting' : 'restart')}</button>
    </span>}
  </p>
}

export function AiSettings({ onPreferences }: { onPreferences?: (preferences: AiPreferences) => void }) {
  useLanguage()
  const [preferences, setPreferences] = useState<AiPreferences>()
  const [draft, setDraft] = useState<Configuration>()
  const [busy, setBusy] = useState<'save' | 'check' | 'restart' | null>(null)
  const [notice, setNotice] = useState<AiCopyKey>()
  const [failed, setFailed] = useState(false)
  const [check, setCheck] = useState<AiCheck>()
  const [aiProblem, setAiProblem] = useState<import('../../../shared/ai').AiProblemEvent | null>(null)
  const accept = useCallback((next: AiPreferences) => { setPreferences(next); setDraft(next.saved); onPreferences?.(next) }, [onPreferences])
  const load = useCallback(async () => {
    setFailed(false); setNotice(undefined)
    try { accept(await window.yogurt.ai.get()) }
    catch { setFailed(true); setNotice('loadFailed') }
  }, [accept])
  useEffect(() => { void load() }, [load])
  useEffect(() => window.yogurt.ai.onProblem(problem => setAiProblem(problem.code ? problem : null)), [])
  const change = (patch: Partial<Configuration>) => { setDraft(previous => previous && { ...previous, ...patch }); setNotice(undefined); setCheck(undefined); setFailed(false) }
  const valid = draft && validAiSettings(draft)
  const dirty = !!draft && !!preferences && !same(draft, preferences.saved)
  const save = async () => {
    if (!draft || !valid || busy) return
    setBusy('save'); setNotice(undefined); setFailed(false)
    try {
      if (draft.backend === 'openrouter' && draft.openrouterTranscriptionKind === 'stt'
        && (draft.openrouterTranscriptionKind !== preferences?.saved.openrouterTranscriptionKind || draft.openrouterTranscriptionModel !== preferences?.saved.openrouterTranscriptionModel)) {
        const result = await window.yogurt.ai.openrouter.probe(draft, 'transcription')
        if (!result.ok) throw new Error('The selected STT model did not return timestamped segments.')
      }
      accept(await window.yogurt.ai.save(draft)); setNotice('saved')
    }
    catch { setFailed(true); setNotice('saveFailed') }
    finally { setBusy(null) }
  }
  const checkExecutable = async () => {
    if (!draft || !valid || busy) return
    setBusy('check'); setCheck(undefined); setNotice(undefined); setFailed(false)
    try { setCheck(await window.yogurt.ai.check(effective(draft, preferences?.locked))) }
    catch { setFailed(true); setNotice('checkFailed') }
    finally { setBusy(null) }
  }
  const restart = async () => {
    if (busy || dirty) return
    setBusy('restart'); setNotice(undefined); setFailed(false)
    try {
      const restarted = await window.yogurt.ai.restart()
      setFailed(!restarted); setNotice(restarted ? 'restarting' : 'restartBlocked')
    } catch { setFailed(true); setNotice('restartFailed') }
    finally { setBusy(null) }
  }

  const shownBackend = draft ? effective(draft, preferences?.locked).backend : undefined
  return <section data-testid="ai-settings" aria-labelledby="ai-settings-heading">
    <h2 id="ai-settings-heading" className="settings-section-heading">{aiText('title')}</h2>
    <p className="ai-settings-intro">{aiText('intro')}</p>
    {!draft || !preferences ? <div className="settings-group"><p className="ai-settings-note" role="status">{aiText(notice ?? 'loading')}</p>
      {failed && <div className="ai-settings-actions"><button type="button" className="workspace-button" onClick={() => void load()}>{aiText('retry')}</button></div>}
    </div> : <form className="settings-group ai-settings-form" onSubmit={e => { e.preventDefault(); void save() }}>
      <AiStatus preferences={preferences} busy={busy} dirty={dirty} restart={() => void restart()} />
      {aiProblem && <p className="ai-settings-status" data-testid="ai-openrouter-problem" role="alert">{aiProblemText(aiProblem.code!, aiProblem.model)}</p>}
      <fieldset disabled={!!busy}>
        <AiSettingsFields value={draft} change={change} locked={preferences.locked} />
        {!valid && <p className="ai-settings-status" role="alert" data-error="true">{aiText('invalid')}</p>}
        <div className="ai-settings-actions">
          {effective(draft, preferences.locked).backend !== preferences.active.backend && <p className="ai-settings-mode-pending" data-testid="ai-mode-pending">{aiText('modeChangePending')}</p>}
          <button type="submit" data-testid="ai-save" className="workspace-button primary" disabled={!valid || !dirty}>{aiText(busy === 'save' ? 'saving' : 'save')}</button>
          {(shownBackend === 'agy' || shownBackend === 'porch') && <button type="button" data-testid="ai-check" className="workspace-button" disabled={!valid} onClick={() => void checkExecutable()}>{aiText(busy === 'check' ? 'checking' : 'check')}</button>}
        </div>
      </fieldset>
      {(shownBackend === 'agy' || shownBackend === 'porch') && <p className="ai-settings-status">{aiText('checkHelp')}</p>}
      {notice && <p data-testid="ai-notice" className="ai-settings-status" data-error={failed} role={failed ? 'alert' : 'status'}>{aiText(notice)}</p>}
      {check && shownBackend !== 'openrouter' && <p data-testid="ai-check-result" className="ai-settings-status" data-error={!check.ok} role={check.ok ? 'status' : 'alert'}>
        {aiText(check.ok ? 'checkPassed' : 'checkFailed')}<span className="ai-settings-result">{check.message}</span>
      </p>}
    </form>}
  </section>
}
