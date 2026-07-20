/**
 * Observation seam for embedders (§3). Purely passive: an observer is told
 * what the tower did, and can do nothing to change the outcome — it cannot
 * reject a job, delay a broadcast, or alter state. This lets a host build
 * things like schedule-aware notifications on top of the reference tower
 * without the tower carrying any policy of its own.
 *
 * All callbacks are optional and best-effort; the tower never awaits them.
 */
export interface TowerObserver {
  /** A job was accepted and is now withheld until `publishAt`. */
  onScheduled?(author: string, publishAt: number, slot: string): void
  /** A valid check-in advanced this author's liveness anchor. */
  onCheckin?(author: string, at: number): void
  /** A withheld capsule was broadcast (the switch fired). */
  onTriggered?(author: string, wrapId: string, publishAt: number): void
}
