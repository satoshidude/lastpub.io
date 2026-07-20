import { describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { QuicknetTlockEngine } from '../src/tlock.js'
import { createCapsule, decryptCapsule, unwrapCapsule } from '../src/capsule.js'
import { roundForTime } from '../src/schedule.js'
import { newSigner } from './helpers.js'

/**
 * Integration tests against the real drand quicknet (network access).
 * Enable with: LASTPUB_INTEGRATION=1 npm test
 */
const enabled = !!process.env.LASTPUB_INTEGRATION

describe.skipIf(!enabled)('quicknet integration (real drand network)', () => {
  const engine = new QuicknetTlockEngine()

  it('engine round trip with an already-reached round', async () => {
    const now = Math.floor(Date.now() / 1000)
    const pastRound = roundForTime(now - 60)
    const age = await engine.encrypt(pastRound, new TextEncoder().encode('integration'))
    const plain = await engine.decrypt(age)
    expect(new TextDecoder().decode(plain)).toBe('integration')
  }, 60_000)

  it('capsule with a near-future round: unwrap ok, decrypt after waiting', async () => {
    const author = newSigner()
    const recipient = newSigner()
    const now = Math.floor(Date.now() / 1000)
    const round = roundForTime(now + 6) // ~2 rounds ahead
    const { wrap } = await createCapsule(author.signer, {
      plaintext: 'readable soon',
      recipient: getPublicKey(recipient.sk),
      round,
      now,
    })
    const { rumor } = await unwrapCapsule(recipient.signer, wrap)
    await new Promise((r) => setTimeout(r, 10_000))
    expect(await decryptCapsule(rumor)).toBe('readable soon')
  }, 60_000)
})
