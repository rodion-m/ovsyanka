import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { validAiSettings, type AiBackend, type AiCheck, type AiEffort, type AiOutputLanguage, type AiPreferences, type AiSettings as Configuration } from '../../../shared/ai'
import { useLanguage } from '../i18n'
import { aiText, aiTextF, type AiCopyKey } from './aiCopy'
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
  return <>
    {select('ai-backend', aiText('backend'), shown.backend, (['agy', 'porch', 'local'] as const).map(v => [v, backendName(v)]), v => change({ backend: v as AiBackend }), lockHelp(locked, 'backend'), !!lock(locked, 'backend'))}
    <p className="ai-settings-note" data-testid="ai-mode-description">{aiText(shown.backend === 'local' ? 'localHelp' : 'subscription')}</p>
    {shown.backend !== 'local' && <>
      {shown.backend === 'agy' && <p className="ai-settings-note">{aiText('defaultModel')}</p>}
      {shown.backend === 'porch' && <>
        {input('transcriptionProfile', 'audioProfile', 'audioProfileHelp')}
        {input('textProfile', 'textProfile', 'textProfileHelp')}
        <p className="ai-settings-note">{aiText('porchAudio')}</p>
      </>}
      {input('transcriptionModel', 'audioModel')}
      {effort('transcriptionEffort', 'audioEffort', ['medium', 'high'])}
      {shown.backend === 'agy' && <>
        {input('textModel', 'textModel', 'textHelp')}
        {effort('textEffort', 'textEffort')}
      </>}
    </>}
    {shown.backend !== 'local' && select('ai-outputLanguage', aiText('outputLanguage'), shown.outputLanguage, [['auto', aiText('auto')], ['ru', aiText('russian')], ['en', aiText('english')]], v => change({ outputLanguage: v as AiOutputLanguage }), aiText('outputHelp'))}
    {shown.backend !== 'local' && <details className="ai-settings-advanced" data-testid="ai-advanced">
      <summary>{aiText('advanced')}</summary>
      {input('agyPath', 'agyPath', 'pathHelp')}
      {shown.backend === 'porch' && input('porchPath', 'porchPath', 'pathHelp')}
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
