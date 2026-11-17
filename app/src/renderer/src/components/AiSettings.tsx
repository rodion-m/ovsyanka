import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { validAiSettings, type AiBackend, type AiCheck, type AiEffort, type AiOutputLanguage, type AiPreferences, type AiSettings as Configuration } from '../../../shared/ai'
import { useLanguage } from '../i18n'
import { aiText, type AiCopyKey } from './aiCopy'
import './AiSettings.css'

const backendName = (backend: AiBackend) => aiText(backend)
const outputName = (output: AiOutputLanguage) => aiText(output === 'ru' ? 'russian' : output === 'en' ? 'english' : 'auto')
const same = (a: Configuration, b: Configuration) => JSON.stringify(a) === JSON.stringify(b)

function Row({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return <div className="settings-row">
    <div className="settings-row-copy"><label htmlFor={id} className="settings-label">{label}</label>
      {help && <p id={`${id}-help`} className="settings-description">{help}</p>}</div>
    {children}
  </div>
}

/** Kept separate so the backend-specific fields can be checked without starting Electron. */
export function AiSettingsFields({ value, change }: { value: Configuration; change(patch: Partial<Configuration>): void }) {
  const input = (key: 'agyPath' | 'porchPath' | 'transcriptionModel' | 'textModel' | 'transcriptionProfile' | 'textProfile', label: AiCopyKey, help?: AiCopyKey) => {
    const id = `ai-${key}`
    return <Row key={key} id={id} label={aiText(label)} help={help && aiText(help)}>
      <input id={id} data-testid={id} className="settings-name-field" value={value[key]} required
        maxLength={key.endsWith('Path') ? 4096 : 200} spellCheck={false} autoComplete="off"
        aria-describedby={help ? `${id}-help` : undefined}
        onChange={e => change({ [key]: e.target.value })} onBlur={e => change({ [key]: e.target.value.trim() })} />
    </Row>
  }
  const select = (id: string, label: string, current: string, options: Array<[string, string]>, choose: (v: string) => void, help?: string) =>
    <Row id={id} label={label} help={help}><span className="settings-select-wrap">
      <select id={id} data-testid={id} className="settings-select" value={current} aria-describedby={help ? `${id}-help` : undefined} onChange={e => choose(e.target.value)}>
        {options.map(([v, title]) => <option key={v} value={v}>{title}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </span></Row>
  const effort = (key: 'transcriptionEffort' | 'textEffort', label: AiCopyKey, options: readonly AiEffort[] = ['low', 'medium', 'high']) =>
    select(`ai-${key}`, aiText(label), value[key], options.map(v => [v, aiText(v)]), v => change({ [key]: v as AiEffort }))
  return <>
    {select('ai-backend', aiText('backend'), value.backend, (['agy', 'porch', 'local'] as const).map(v => [v, backendName(v)]), v => change({ backend: v as AiBackend }))}
    <p className="ai-settings-note" data-testid="ai-mode-description">{aiText(value.backend === 'local' ? 'localHelp' : 'subscription')}</p>
    {value.backend !== 'local' && <>
      {value.backend === 'agy' && <p className="ai-settings-note">{aiText('defaultModel')}</p>}
      {value.backend === 'porch' && <>
        {input('transcriptionProfile', 'audioProfile', 'audioProfileHelp')}
        {input('textProfile', 'textProfile', 'textProfileHelp')}
        <p className="ai-settings-note">{aiText('porchAudio')}</p>
      </>}
      {input('transcriptionModel', 'audioModel')}
      {effort('transcriptionEffort', 'audioEffort', ['medium', 'high'])}
      {value.backend === 'agy' && <>
        {input('textModel', 'textModel', 'textHelp')}
        {effort('textEffort', 'textEffort')}
      </>}
    </>}
    {value.backend !== 'local' && select('ai-outputLanguage', aiText('outputLanguage'), value.outputLanguage, [['auto', aiText('auto')], ['ru', aiText('russian')], ['en', aiText('english')]], v => change({ outputLanguage: v as AiOutputLanguage }), aiText('outputHelp'))}
    {value.backend !== 'local' && <details className="ai-settings-advanced" data-testid="ai-advanced">
      <summary>{aiText('advanced')}</summary>
      {input('agyPath', 'agyPath', 'pathHelp')}
      {value.backend === 'porch' && input('porchPath', 'porchPath', 'pathHelp')}
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

export function AiActiveSettings({ active }: { active: Configuration }) {
  return <p className="ai-settings-note" data-testid="ai-active"><strong>{aiText('active')}:</strong> {backendName(active.backend)}
    {active.backend !== 'local' && <>
      <span className="ai-settings-result">
        {aiText(active.backend === 'porch' ? 'audioProfile' : 'audioModel')}: {active.backend === 'porch' ? `${active.transcriptionProfile} · ` : ''}{active.transcriptionModel} · {active.transcriptionEffort}<br />
        {aiText(active.backend === 'porch' ? 'textProfile' : 'textModel')}: {active.backend === 'porch' ? active.textProfile : `${active.textModel} · ${active.textEffort}`}
      </span>
      <span className="ai-settings-result">{aiText('outputLanguage')}: {outputName(active.outputLanguage)}</span>
    </>}
  </p>
}

export function AiEnvironmentNotice({ overrides }: { overrides: AiPreferences['environmentOverrides'] }) {
  if (!overrides?.length) return null
  const labels = { YOGURT_AI_BACKEND: 'backend', YOGURT_AGY_PATH: 'agyPath', YOGURT_PORCH_PATH: 'porchPath' } as const
  return <p className="ai-settings-note" data-testid="ai-environment-overrides" role="status">
    {aiText('environmentOverrides')}
    <span className="ai-settings-result">{overrides.map(key => `${aiText(labels[key])} (${key})`).join(', ')}</span>
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
    try { setCheck(await window.yogurt.ai.check(draft)) }
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

  return <section data-testid="ai-settings" aria-labelledby="ai-settings-heading">
    <h2 id="ai-settings-heading" className="settings-section-heading">{aiText('title')}</h2>
    <p className="ai-settings-intro">{aiText('intro')}</p>
    {!draft || !preferences ? <div className="settings-group"><p className="ai-settings-note" role="status">{aiText(notice ?? 'loading')}</p>
      {failed && <div className="ai-settings-actions"><button type="button" className="workspace-button" onClick={() => void load()}>{aiText('retry')}</button></div>}
    </div> : <form className="settings-group ai-settings-form" onSubmit={e => { e.preventDefault(); void save() }}>
      <AiActiveSettings active={preferences.active} />
      <AiEnvironmentNotice overrides={preferences.environmentOverrides} />
      <fieldset disabled={!!busy}>
        <AiSettingsFields value={draft} change={change} />
        {!valid && <p className="ai-settings-status" role="alert" data-error="true">{aiText('invalid')}</p>}
        <div className="ai-settings-actions">
          <button type="submit" data-testid="ai-save" className="workspace-button primary" disabled={!valid || !dirty}>{aiText(busy === 'save' ? 'saving' : 'save')}</button>
          {draft.backend !== 'local' && <button type="button" data-testid="ai-check" className="workspace-button" disabled={!valid} onClick={() => void checkExecutable()}>{aiText(busy === 'check' ? 'checking' : 'check')}</button>}
          {preferences.restartRequired && <button type="button" data-testid="ai-restart" className="workspace-button" disabled={dirty} onClick={() => void restart()}>{aiText(busy === 'restart' ? 'restarting' : 'restart')}</button>}
        </div>
      </fieldset>
      {draft.backend !== 'local' && <p className="ai-settings-status">{aiText('checkHelp')}</p>}
      {preferences.restartRequired && <p data-testid="ai-restart-required" className="ai-settings-status" role="status">{aiText('restartNeeded')}{dirty && <> {aiText('saveFirst')}</>}</p>}
      {notice && <p data-testid="ai-notice" className="ai-settings-status" data-error={failed} role={failed ? 'alert' : 'status'}>{aiText(notice)}</p>}
      {check && <p data-testid="ai-check-result" className="ai-settings-status" data-error={!check.ok} role={check.ok ? 'status' : 'alert'}>
        {aiText(check.ok ? 'checkPassed' : 'checkFailed')}<span className="ai-settings-result">{check.message}</span>
      </p>}
    </form>}
  </section>
}
