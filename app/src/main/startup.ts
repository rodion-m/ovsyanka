/**
 * What runs once the models are ready: notes recovery, folder suggestions and indexing first (as before
 * spool recovery existed); pending remote audio is recovered after them, in the background, one meeting at a time.
 */
export function runCatchUp(d: {
  rejoined: Promise<unknown>
  notes: { recover(): void }
  folders: { refresh(): unknown }
  index: { schedule(): unknown }
  recoverTranscripts: () => Promise<unknown>
}): void {
  void d.rejoined.catch((e) => console.warn('audio startup repair retained its files', e)).finally(() => {
    d.notes.recover()
    void d.folders.refresh()
    void d.index.schedule()
    void d.recoverTranscripts()
  })
}
