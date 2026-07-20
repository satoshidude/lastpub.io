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
 * Time model (spec §1.1): two parameters, everything else derived.
 * Invariant: roundTime − publishAt = grace.
 */
export function computeSchedule(
  lastCheckinAt: number,
  interval: number,
  grace: number,
  chain: ChainParams = QUICKNET,
): Schedule {
  if (interval <= 0 || grace <= 0) {
    throw new Error('interval and grace must be positive seconds')
  }
  const deadline = lastCheckinAt + interval
  const publishAt = deadline
  const roundTime = deadline + grace
  return { deadline, publishAt, roundTime, round: roundForTime(roundTime, chain) }
}
