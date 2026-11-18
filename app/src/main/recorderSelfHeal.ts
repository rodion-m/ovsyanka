/** JavaScript mirror of the native recorder's self-heal gate, kept testable without a Swift test target. */
export function shouldRebuildSystem(p: { zeroMs: number; outputProcesses: number; rebuilds: number; backoffDue: boolean }): boolean {
  return p.zeroMs >= 60_000 && p.outputProcesses > 0 && p.rebuilds < 5 && p.backoffDue
}

export function shouldResetBackoff(nonZeroMs: number): boolean { return nonZeroMs >= 10_000 }
