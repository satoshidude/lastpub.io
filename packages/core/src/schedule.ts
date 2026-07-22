import { QUICKNET, type ChainParams } from './constants.js'
import type { Schedule } from './types.js'

/**
 * Smallest round whose beacon does not appear before `t` (Unix seconds).
 * drand reference: the beacon for round r appears at genesis + (r−1)·period,
 * round 1 sits at the genesis (drand-client `roundTime`).
 */
export function roundForTime(t: number, chain: ChainParams = QUICKNET): number {
  return Math.max(1, Math.ceil((t - chain.genesis) / chain.period) + 1)
}

/** Unix seconds at which the beacon for the round appears. */
export function timeForRound(round: number, chain: ChainParams = QUICKNET): number {
  return chain.genesis + (Math.max(1, round) - 1) * chain.period
}

/**
 * Time model (spec §1.1): one parameter, everything else derived. The trigger
 * is the deadline, and the capsule's round is the first beacon at or after it —
 * so the message becomes readable the moment it is published. There is no
 * window between publication and readability.
 */
export function computeSchedule(
  lastCheckinAt: number,
  interval: number,
  chain: ChainParams = QUICKNET,
): Schedule {
  if (interval <= 0) {
    throw new Error('interval must be positive seconds')
  }
  const deadline = lastCheckinAt + interval
  const publishAt = deadline
  return { deadline, publishAt, round: roundForTime(publishAt, chain) }
}
