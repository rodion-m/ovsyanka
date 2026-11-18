import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { searchAiOptions, type AiHint, type AiOption } from '../../../shared/aiCatalog'
import { language } from '../../../shared/i18n'
import { aiText, aiTextF, type AiCopyKey } from './aiCopy'
import './ModelPicker.css'

export type ModelPickerGroup = { id: AiOption['group']; label: string; vendor?: string }

/** What the list can show beyond plain rows; `cache`/`empty`/`error` come with the network-backed catalogs. */
export type ModelPickerState =
  | { status: 'ready' }
  | { status: 'loading' }
  | { status: 'cache'; fetchedAt?: number; onRetry?(): void }
  | { status: 'empty'; onRetry?(): void }
  | { status: 'error'; message: string; onRetry?(): void; keepOptions?: boolean }

export type ModelPickerProps = {
  id: string
  label?: string
  value: string
  options: readonly AiOption[]
  /** Groups render in this order; options in other groups follow ungrouped. */
  groups?: readonly ModelPickerGroup[]
  onChange(id: string): void
  allowCustom?: boolean
  showErrorWhenClosed?: boolean
  validateCustom?(id: string): boolean
  state?: ModelPickerState
  /** Set by a launch variable: the control shows the effective value but cannot be opened. */
  locked?: boolean
  /** Extra line under the closed field (e.g. why the shown list fell back to built-in). */
  hint?: string
  /** Optional controls above the list, such as a refresh button. */
  toolbar?: ReactNode
  describedBy?: string
}

const hintKey: Record<Exclude<AiHint, 'unavailable'>, AiCopyKey> = {
  audio: 'hintAudio', verified: 'hintVerified', fast: 'hintFast', cheap: 'hintCheap',
  free: 'hintFree', tokens: 'hintTokens', expiring: 'hintExpiring', experimental: 'sttExperimental',
}
const money = (usd: number) => usd < 0.01 ? usd.toPrecision(1) : usd.toFixed(2)
const monthYear = (seconds: number) => new Intl.DateTimeFormat(language(), { month: 'short', year: 'numeric' }).format(new Date(seconds * 1000))
const longDate = (ms: number) => new Intl.DateTimeFormat(language(), { day: 'numeric', month: 'long' }).format(new Date(ms))

function price(option: AiOption): string | undefined {
  const p = option.price
  if (!p) return undefined
  if (p.perHourUsd !== undefined) return aiTextF('pricePerHour', { x: money(p.perHourUsd) })
  if (p.inPerMillionUsd !== undefined && p.outPerMillionUsd !== undefined) {
    return aiTextF('pricePerMillion', { in: money(p.inPerMillionUsd), out: money(p.outPerMillionUsd) })
  }
  return undefined
}

/** ID plus the key facts as plain text, so meaning never rides on colour alone. */
function facts(option: AiOption): string {
  return [
    option.id,
    ...option.hints.filter(h => h !== 'unavailable').map(h => aiText(hintKey[h])),
    ...(option.hints.includes('experimental') ? [aiText('sttExperimentalHint')] : []),
    option.detail,
    price(option),
    option.addedAt === undefined ? undefined : aiTextF('addedOn', { when: monthYear(option.addedAt) }),
  ].filter(Boolean).join(' · ')
}

type Row = { key: string; domId: string; option?: AiOption; custom?: string }

export function ModelPicker({ id, label, value, options, groups, onChange, allowCustom, showErrorWhenClosed, validateCustom, state, locked, hint, toolbar, describedBy }: ModelPickerProps) {
  const status = state?.status ?? 'ready'
  const selected = options.find(option => option.id === value)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  const listed = status === 'ready' || status === 'cache' || (status === 'error' && !!state && 'keepOptions' in state && state.keepOptions === true)
  const filtered = useMemo(() => listed ? searchAiOptions(options, query) : [], [listed, options, query])
  const indexOf = useMemo(() => new Map(options.map((option, index) => [option, index])), [options])
  const domIdOf = (option: AiOption) => `${id}-option-${indexOf.get(option) ?? 0}`

  const trimmed = query.trim()
  const inList = (text: string) => options.some(option => option.id.toLowerCase() === text.toLowerCase() || option.label.toLowerCase() === text.toLowerCase())
  const customWanted = !!allowCustom && !!trimmed && !inList(trimmed)
  const customValid = customWanted && (validateCustom ? validateCustom(trimmed) : true)
  const rows: Row[] = [
    ...filtered.filter(option => !option.disabledReason).map(option => ({ key: `o:${option.id}`, domId: domIdOf(option), option })),
    ...(customValid ? [{ key: 'custom', domId: `${id}-custom`, custom: trimmed }] : []),
  ]
  const activeIndex = Math.max(0, rows.findIndex(row => row.key === active))
  const activeDomId = open ? rows[activeIndex]?.domId : undefined

  const scrollToActive = (domId?: string) => {
    if (!domId) return
    try { root.current?.querySelector(`[id="${CSS.escape(domId)}"]`)?.scrollIntoView?.({ block: 'nearest' }) } catch { /* scrollIntoView may be absent in test DOMs */ }
  }

  const openList = () => {
    if (locked || open) return
    setQuery('')
    const first = options.find(option => !option.disabledReason)
    setActive(selected && !selected.disabledReason ? `o:${selected.id}` : first ? `o:${first.id}` : undefined)
    setOpen(true)
  }
  const closeList = () => setOpen(false)
  const commit = (row: Row) => {
    onChange(row.option ? row.option.id : row.custom!)
    closeList()
  }
  const move = (delta: number) => {
    const next = rows.length ? rows[(activeIndex + delta + rows.length) % rows.length] : undefined
    setActive(next?.key)
    scrollToActive(next?.domId)
  }
  const retype = (text: string) => {
    setQuery(text)
    const found = searchAiOptions(options, text).filter(option => !option.disabledReason)
    const t = text.trim()
    const custom = !!allowCustom && !!t && !inList(t) && (validateCustom ? validateCustom(t) : true)
    setActive(found[0] ? `o:${found[0].id}` : custom ? 'custom' : undefined)
  }

  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) openList()
      else move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!open) openList()
      else {
        const row = rows[activeIndex]
        if (row) commit(row)
      }
    } else if (e.key === 'Escape') {
      // Escape can only ever close; the committed value is the one shown before opening.
      if (open) { e.preventDefault(); e.stopPropagation(); closeList() }
    } else if (e.key === 'Tab' && open) {
      closeList()
    }
  }

  const retry = (onRetry?: () => void) => onRetry && <button type="button" className="model-picker-retry" onMouseDown={e => e.preventDefault()} onClick={onRetry}>{aiText('retry')}</button>
  const notice = (text: string, onRetry?: () => void) => <p className="model-picker-note">{text}{retry(onRetry)}</p>

  const sub = selected
    ? facts(selected)
    : [value, aiText(allowCustom ? 'hintCustom' : 'hintMissing')].filter(Boolean).join(' · ')

  return <div className="model-picker" ref={root} data-open={open || undefined}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeList() }}>
    {label && <label htmlFor={id} className="settings-label">{label}</label>}
    <span className="model-picker-field">
      <input id={id} data-testid={id} ref={input} role="combobox" aria-haspopup="listbox"
        className="settings-name-field model-picker-input" value={open ? query : (selected?.label ?? value)}
        readOnly={!open} disabled={locked} spellCheck={false} autoComplete="off" placeholder={aiText('pickerSearch')}
        aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={activeDomId}
        aria-describedby={describedBy}
        onMouseDown={() => { if (!open) openList() }}
        onChange={e => { if (!open) setOpen(true); retype(e.target.value) }}
        onKeyDown={key} />
      {open && query
        ? <button type="button" className="model-picker-clear" aria-label={aiText('pickerClear')} title={aiText('pickerClear')}
            onMouseDown={e => e.preventDefault()} onClick={() => retype('')}><X size={13} aria-hidden="true" /></button>
        : <ChevronDown size={14} aria-hidden="true" className="model-picker-chevron" />}
    </span>
    {!open && <p className="model-picker-sub" data-testid={`${id}-sub`}>{sub}</p>}
    {!open && hint && <p className="model-picker-sub">{hint}</p>}
    {!open && showErrorWhenClosed && status === 'error' && state && 'message' in state && notice(state.message, 'onRetry' in state ? state.onRetry : undefined)}
    {open && <div className="model-picker-pop">
      {status === 'loading' && <>
        {notice(aiText('listLoading'))}
        {[0, 1, 2].map(n => <div key={n} className="model-picker-skeleton" aria-hidden="true" />)}
      </>}
      {status === 'cache' && notice(aiTextF('listOffline', { when: state && 'fetchedAt' in state && state.fetchedAt ? longDate(state.fetchedAt) : '—' }), state && 'onRetry' in state ? state.onRetry : undefined)}
      {(status === 'empty' || status === 'error') && notice(status === 'error' && state && 'message' in state ? state.message : aiText('listUnavailable'), state && 'onRetry' in state ? state.onRetry : undefined)}
      {toolbar}
      <div role="listbox" id={`${id}-list`} className="model-picker-list" aria-label={label}>
        {(groups ?? []).map(group => {
          const inside = filtered.filter(option => option.group === group.id && (!group.vendor || option.vendor === group.vendor))
          const groupDomId = `${id}-group-${group.id}${group.vendor ? `-${group.vendor}` : ''}`
          return inside.length > 0 && <div key={`${group.id}:${group.vendor ?? ''}`} role="group" aria-labelledby={groupDomId}>
            <div id={groupDomId} className="model-picker-group">{group.label}</div>
            {inside.map(option => <OptionRow key={option.id} id={domIdOf(option)} option={option} current={value}
              highlighted={activeDomId === domIdOf(option)} select={() => commit(rows.find(row => row.option === option)!)} />)}
          </div>
        })}
        {filtered.filter(option => !(groups ?? []).some(group => group.id === option.group))
          .map(option => <OptionRow key={option.id} id={domIdOf(option)} option={option} current={value}
            highlighted={activeDomId === domIdOf(option)} select={() => commit(rows.find(row => row.option === option)!)} />)}
        {customValid && <div role="option" id={`${id}-custom`} aria-selected={trimmed === value} data-active={activeDomId === `${id}-custom` || undefined}
          className="model-picker-option" onMouseDown={e => e.preventDefault()}
          onClick={() => commit(rows.find(row => row.key === 'custom')!)}>
          <span className="model-picker-check" aria-hidden="true" />
          <span className="model-picker-name">{aiTextF('pickerCustom', { x: trimmed })}</span>
          <span className="model-picker-hints"><span className="model-picker-hint">{aiText('hintCustom')}</span></span>
        </div>}
        {customWanted && !customValid && <div className="model-picker-option model-picker-invalid" role="presentation">
          <span className="model-picker-check" aria-hidden="true" />
          <span className="model-picker-name">{aiText('customInvalid')}</span>
        </div>}
      </div>
      {listed && filtered.length === 0 && trimmed && <p className="model-picker-note">{aiTextF('nothingFound', { x: trimmed })}</p>}
      <p role="status" className="sr-only">{aiTextF('pickerCount', { n: String(filtered.filter(option => !option.disabledReason).length) })}</p>
    </div>}
  </div>
}

function OptionRow({ id, option, current, highlighted, select }: { id: string; option: AiOption; current: string; highlighted: boolean; select(): void }) {
  return <div role="option" id={id} aria-selected={option.id === current} aria-disabled={!!option.disabledReason || undefined}
    data-active={highlighted || undefined} className="model-picker-option" onMouseDown={e => e.preventDefault()}
    onClick={() => { if (!option.disabledReason) select() }}>
    <span className="model-picker-check" aria-hidden="true">{option.id === current && <Check size={13} />}</span>
    <span className="model-picker-name">{option.label}</span>
    <span className="model-picker-hints">{option.hints.filter(h => h !== 'unavailable').map(h => <span key={h} className="model-picker-hint">{aiText(hintKey[h])}</span>)}</span>
    <span className="model-picker-sub">{option.disabledReason === 'backend-unavailable' ? aiText('profileUnavailable') : option.disabledReason === 'soon' ? aiText('sttSoon') : option.disabledReason ?? facts(option)}</span>
    {option.hints.includes('experimental') && <span className="model-picker-sub">{aiText('sttExperimentalHint')}</span>}
  </div>
}
