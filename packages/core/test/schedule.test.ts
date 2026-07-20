import { describe, expect, it } from 'vitest'
import { computeSchedule, roundForTime, timeForRound } from '../src/schedule.js'
import { QUICKNET, DEFAULT_PRESET } from '../src/constants.js'

describe('roundForTime / timeForRound', () => {
  it('round 1 sits at the genesis (drand reference)', () => {
    expect(timeForRound(1)).toBe(QUICKNET.genesis)
    expect(roundForTime(QUICKNET.genesis)).toBe(1)
  })

  it('returns the smallest round whose beacon does not appear before t', () => {
    // exactly on a period boundary: beacon exactly at t
    const t = QUICKNET.genesis + 10 * QUICKNET.period
    expect(timeForRound(roundForTime(t))).toBe(t)
    // between two rounds: the next round after
    const t2 = t + 1
    const r2 = roundForTime(t2)
    expect(timeForRound(r2)).toBeGreaterThanOrEqual(t2)
    expect(timeForRound(r2 - 1)).toBeLessThan(t2)
  })

  it('clamps to round 1 before the genesis', () => {
    expect(roundForTime(QUICKNET.genesis - 1000)).toBe(1)
  })

  it('hand calculation: genesis + 100s → ceil(100/3)+1 = 35', () => {
    expect(roundForTime(QUICKNET.genesis + 100)).toBe(35)
    expect(timeForRound(35)).toBe(QUICKNET.genesis + 34 * 3)
  })
})

describe('computeSchedule', () => {
  const anchor = 1_800_000_000

  it('invariant: roundTime − publishAt = grace', () => {
    const { interval, grace } = DEFAULT_PRESET
    const s = computeSchedule(anchor, interval, grace)
    expect(s.deadline).toBe(anchor + interval)
    expect(s.publishAt).toBe(s.deadline)
    expect(s.roundTime - s.publishAt).toBe(grace)
  })

  it('the beacon for the computed round never appears before roundTime', () => {
    for (const off of [0, 1, 2, 3, 59, 3600]) {
      const s = computeSchedule(anchor + off, 7 * 86400, 3 * 86400)
      expect(timeForRound(s.round)).toBeGreaterThanOrEqual(s.roundTime)
      expect(timeForRound(s.round) - s.roundTime).toBeLessThan(QUICKNET.period)
    }
  })

  it('throws on non-positive parameters', () => {
    expect(() => computeSchedule(anchor, 0, 3)).toThrow()
    expect(() => computeSchedule(anchor, 7, -1)).toThrow()
  })
})
