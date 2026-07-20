import { describe, expect, it } from 'vitest'
import { createCheckin, verifyCheckin } from '../src/checkin.js'
import { CHECKIN_TOLERANCE_SEC } from '../src/constants.js'
import { newSigner } from './helpers.js'

const now = 1_800_000_000

describe('createCheckin / verifyCheckin', () => {
  it('valid 1042 passes all checks', async () => {
    const { signer } = newSigner()
    const e = await createCheckin(signer, { now })
    expect(e.kind).toBe(1042)
    const v = verifyCheckin(e, { lastCreatedAt: now - 100, seenIds: new Set(), now })
    expect(v).toEqual({ ok: true })
  })

  it('replay: non-monotonic created_at is rejected', async () => {
    const { signer } = newSigner()
    const e = await createCheckin(signer, { now })
    expect(verifyCheckin(e, { lastCreatedAt: now, seenIds: new Set(), now })).toEqual({
      ok: false,
      reason: 'monotonic',
    })
    expect(verifyCheckin(e, { lastCreatedAt: now + 10, seenIds: new Set(), now })).toEqual({
      ok: false,
      reason: 'monotonic',
    })
  })

  it('replay: already-seen event ID is rejected', async () => {
    const { signer } = newSigner()
    const e = await createCheckin(signer, { now })
    const v = verifyCheckin(e, { lastCreatedAt: 0, seenIds: new Set([e.id]), now })
    expect(v).toEqual({ ok: false, reason: 'replay' })
  })

  it('tolerance: ±10 minutes, bounds inclusive', async () => {
    const { signer } = newSigner()
    const state = { lastCreatedAt: 0, seenIds: new Set<string>() }
    const atLimit = await createCheckin(signer, { now })
    expect(verifyCheckin(atLimit, { ...state, now: now + CHECKIN_TOLERANCE_SEC })).toEqual({
      ok: true,
    })
    expect(
      verifyCheckin(atLimit, { ...state, now: now + CHECKIN_TOLERANCE_SEC + 1 }),
    ).toEqual({ ok: false, reason: 'tolerance' })
    expect(
      verifyCheckin(atLimit, { ...state, now: now - CHECKIN_TOLERANCE_SEC - 1 }),
    ).toEqual({ ok: false, reason: 'tolerance' })
  })

  it('tampered signature is rejected', async () => {
    const { signer } = newSigner()
    const e = await createCheckin(signer, { now })
    const forged = { ...e, content: 'x' }
    expect(verifyCheckin(forged, { lastCreatedAt: 0, seenIds: new Set(), now }).ok).toBe(false)
  })

  it('wrong kind is rejected', async () => {
    const { signer } = newSigner()
    const e = await signer.signEvent({ kind: 1, created_at: now, content: '', tags: [] })
    expect(verifyCheckin(e, { lastCreatedAt: 0, seenIds: new Set(), now })).toEqual({
      ok: false,
      reason: 'kind',
    })
  })
})
