import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { validAiSettings, type AiBackend, type AiCheck, type AiEffort, type AiOutputLanguage, type AiPreferences, type AiSettings as Configuration } from '../../../shared/ai'
import { agyTextOptions, agyTranscriptionOptions, validCustomId, type AiOption, type AiOptions } from '../../../shared/aiCatalog'
import { useLanguage } from '../i18n'
import { aiText, aiTextF, type AiCopyKey } from './aiCopy'
import { ModelPicker, type ModelPickerGroup } from './ModelPicker'
import './AiSettings.css'

const backendName = (backend: AiBackend) => aiText(backend)
const same = (a: Configuration, b: Configuration) => JSON.stringify(a) === JSON.stringify(b)
/** The status line's one-line summary of a configuration: mode plus what transcribes. */
const summary = (s: Configuration) => backendName(s.backend) + (s.backend === 'local' ? '' : ` · ${s.backend === 'porch' ? s.transcriptionProfile : s.transcriptionModel}`)
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

function Row({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return <div className="settings-row">
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
    try { setCatalog(await window.yogurt.ai.options({ backend: shown.backend === 'porch' ? 'porch' : 'agy', refresh: true, agyPath: shown.agyPath, porchPath: shown.porchPath })) }
    catch { setCatalog(shown.backend === 'porch' ? { transcription: [], text: [], source: 'builtin', problem: 'unavailable' } : { ...AGY_BUILTIN_OPTIONS, problem: 'unavailable' }) }
    finally { setCatalogBusy(false) }
  }
  useEffect(() => {
    if (shown.backend === 'porch') {
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
        state={catalogBusy ? { status: 'loading' } : catalog.problem ? { status: 'error', message: aiText('agyListFailed'), onRetry: () => void refreshCatalog(), keepOptions: true } : { status: 'ready' }}
        toolbar={<button type="button" className="model-picker-retry" aria-label={aiText('refreshList')} title={aiText('refreshList')} disabled={catalogBusy} onMouseDown={e => e.preventDefault()} onClick={() => void refreshCatalog()}><RefreshCw size={14} aria-hidden="true" /></button>}
        describedBy={helpText ? `${id}-help` : undefined} allowCustom validateCustom={validCustomId}
        onChange={pickModel(key, options, fallback)} />
    </Row>
  }
  return <>
    {select('ai-backend', aiText('backend'), shown.backend, (['agy', 'porch', 'local'] as const).map(v => [v, backendName(v)]), v => change({ backend: v as AiBackend }), lockHelp(locked, 'backend'), !!lock(locked, 'backend'))}
    <p className="ai-settings-note" data-testid="ai-mode-description">{aiText(shown.backend === 'local' ? 'localHelp' : 'subscription')}</p>
    {shown.backend !== 'local' && <>
      {shown.backend === 'agy' && <p className="ai-settings-note">{aiText('defaultModel')}</p>}
      {shown.backend === 'porch' && <>
        <Row id="ai-transcriptionProfile" label={aiText('audioProfile')} help={aiText('audioProfileHelp')}>
          <ModelPicker id="ai-transcriptionProfile" value={shown.transcriptionProfile} options={catalog.transcription} groups={[{ id: 'audio', label: aiText('porchTranscriptionGroup') }, ...pickerGroups(['unavailable'])]}
            allowCustom validateCustom={id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)} onChange={id => {
              const selected = catalog.transcription.find(option => option.id === id)
              const profileModel = selected?.detail?.split(' · ').at(-1)
              change({ transcriptionProfile: id, ...(profileModel ? { transcriptionModel: profileModel } : {}) })
            }} state={catalogBusy ? { status: 'loading' } : catalog.problem ? { status: 'error', message: aiText('porchListFailed'), onRetry: () => void refreshCatalog() } : { status: 'ready' }}
            toolbar={<button type="button" className="model-picker-retry" aria-label={aiText('refreshList')} title={aiText('refreshList')} disabled={catalogBusy} onMouseDown={e => e.preventDefault()} onClick={() => void refreshCatalog()}><RefreshCw size={14} aria-hidden="true" /></button>} />
        </Row>
        <Row id="ai-textProfile" label={aiText('textProfile')} help={aiText('textProfileHelp')}>
          <ModelPicker id="ai-textProfile" value={shown.textProfile} options={catalog.text} groups={porchTextGroups(catalog.text)} allowCustom showErrorWhenClosed
            validateCustom={id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)} onChange={id => change({ textProfile: id })}
            state={catalogBusy ? { status: 'loading' } : catalog.problem ? { status: 'error', message: aiText('porchListFailed'), onRetry: () => void refreshCatalog() } : { status: 'ready' }}
            toolbar={<button type="button" className="model-picker-retry" aria-label={aiText('refreshList')} title={aiText('refreshList')} disabled={catalogBusy} onMouseDown={e => e.preventDefault()} onClick={() => void refreshCatalog()}><RefreshCw size={14} aria-hidden="true" /></button>} />
        </Row>
        <p className="ai-settings-note">{aiText('porchTextNote')}</p>
      </>}
      {shown.backend === 'agy'
        ? picker('transcriptionModel', 'audioModel', catalog.transcription, ['recommended', 'audio'], undefined, ['medium', 'high'])
        : shown.backend === 'porch' ? null : input('transcriptionModel', 'audioModel')}
      {effort('transcriptionEffort', 'audioEffort', shown.backend === 'agy' ? withoutLow(effortsOf(AGY_TRANSCRIPTION, shown.transcriptionModel, ['medium', 'high']), ['medium', 'high']) : ['medium', 'high'])}
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
  const accept = useCallback((next: AiPreferences) => { setPreferences(next); setDraft(next.saved); onPreferences?.(next) }, [onPreferences])
  const load = useCallback(async () => {
    setFailed(false); setNotice(undefined)
    try { accept(await window.yogurt.ai.get()) }
    catch { setFailed(true); setNotice('loadFailed') }
  }, [accept])
  useEffect(() => { void load() }, [load])
  const change = (patch: Partial<Configuration>) => { setDraft(previous => previous && { ...previous, ...patch }); setNotice(undefined); setCheck(undefined); setFailed(false) }
  const valid = draft && validAiSettings(draft)
  const dirty = !!draft && !!preferences && !same(draft, preferences.saved)
  const save = async () => {
    if (!draft || !valid || busy) return
    setBusy('save'); setNotice(undefined); setFailed(false)
    try { accept(await window.yogurt.ai.save(draft)); setNotice('saved') }
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
      <fieldset disabled={!!busy}>
        <AiSettingsFields value={draft} change={change} locked={preferences.locked} />
        {!valid && <p className="ai-settings-status" role="alert" data-error="true">{aiText('invalid')}</p>}
        <div className="ai-settings-actions">
          <button type="submit" data-testid="ai-save" className="workspace-button primary" disabled={!valid || !dirty}>{aiText(busy === 'save' ? 'saving' : 'save')}</button>
          {shownBackend !== 'local' && <button type="button" data-testid="ai-check" className="workspace-button" disabled={!valid} onClick={() => void checkExecutable()}>{aiText(busy === 'check' ? 'checking' : 'check')}</button>}
        </div>
      </fieldset>
      {shownBackend !== 'local' && <p className="ai-settings-status">{aiText('checkHelp')}</p>}
      {notice && <p data-testid="ai-notice" className="ai-settings-status" data-error={failed} role={failed ? 'alert' : 'status'}>{aiText(notice)}</p>}
      {check && <p data-testid="ai-check-result" className="ai-settings-status" data-error={!check.ok} role={check.ok ? 'status' : 'alert'}>
        {aiText(check.ok ? 'checkPassed' : 'checkFailed')}<span className="ai-settings-result">{check.message}</span>
      </p>}
    </form>}
  </section>
}
