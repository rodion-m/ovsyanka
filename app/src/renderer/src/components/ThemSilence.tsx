import { useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import type { WidgetView } from '../../../shared/types'
import { t } from '../../../shared/i18n'

/**
 * The silent-"them" warning under the note: calm and never modal. The banner offers the two ways
 * out — restart the sound capture, or don't warn for this meeting (a quiet line with Undo replaces
 * it). Everything is announced through role="status" without moving focus.
 */
export function ThemSilence({ view }: { view: WidgetView }) {
  const [busy, setBusy] = useState(false)
  if (view.themMuted) {
    return (
      <div data-testid="them-muted" role="status" className="pointer-events-auto mx-auto mt-3 flex w-fit max-w-[640px] items-center gap-2.5 rounded-xl border border-line bg-float px-4 py-2 text-[13px] leading-snug text-muted shadow-[var(--shadow)]">
        <span>{t('Warnings are off for this meeting')}</span>
        <button data-testid="them-unmute" onClick={() => void window.yogurt.meetings.unmuteThemSilence(view.meetingId)} className="workspace-button shrink-0">{t('Undo')}</button>
      </div>
    )
  }
  const note = view.note
  if (note?.code !== 'them-silent') return null
  const phase = note.them ?? 'warn'
  if (phase === 'ok') {
    return (
      <div data-testid="them-ok" role="status" className="pointer-events-auto mx-auto mt-3 flex w-fit max-w-[640px] items-center gap-2.5 rounded-xl border border-line bg-float px-4 py-2 text-[13px] leading-snug shadow-[var(--shadow)]">
        <Check size={14} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden="true" />
        <span>{t("The other side's sound is being recorded again")}</span>
      </div>
    )
  }
  const restarting = phase === 'restarting'
  const failed = phase === 'failed'
  const restart = () => {
    setBusy(true)
    void window.yogurt.meetings.restartSoundCapture(view.meetingId).finally(() => setBusy(false))
  }
  return (
    <div data-testid="them-silent" data-phase={phase} role="status" aria-live="polite" className="pointer-events-auto mx-auto mt-3 flex w-fit max-w-[640px] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-float px-4 py-3 text-[13px] leading-snug shadow-[var(--shadow)]">
      <TriangleAlert size={16} strokeWidth={1.75} className="shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-48 flex-1">
        <p className="font-medium">{t("Can't hear the other side")}</p>
        <p className="mt-0.5 text-muted">
          {failed
            ? t("That didn't help. Check the sound output in your system settings or the call app.")
            : t("The computer's sound hasn't been recorded for a minute. If this is a webinar or you're presenting alone, that's fine.")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button data-testid="them-restart" disabled={restarting || busy} onClick={restart} className="workspace-button primary">
          {restarting || busy ? t('Restarting sound capture…') : t('Restart sound capture')}
        </button>
        <button data-testid="them-mute" disabled={restarting} onClick={() => void window.yogurt.meetings.muteThemSilence(view.meetingId)} className="workspace-button">
          {t("Don't warn for this meeting")}
        </button>
      </div>
    </div>
  )
}
