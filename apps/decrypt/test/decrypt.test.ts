import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import * as nip19 from 'nostr-tools/nip19'
import WebSocket from 'ws'
import {
  LocalSigner,
  buildExport,
  buildWrapRevocation,
  createCapsule,
  roundForTime,
  timeForRound,
  unwrapCapsule,
} from '@lastpub/core'
import { MiniRelay } from '@lastpub/tower'
import {
  checkRevoked,
  fetchWrap,
  parseFile,
  parseInput,
  roundStatus,
} from '../src/lib/decrypt.js'

useWebSocketImplementation(WebSocket)

describe('Decrypt page: logic (§5)', () => {
  let relay: MiniRelay
  let pool: SimplePool
  const author = new LocalSigner(generateSecretKey())
  const recipientSk = generateSecretKey()
  const recipient = new LocalSigner(recipientSk)
  const now = Math.floor(Date.now() / 1000)
  const round = roundForTime(now + 86400)

  beforeAll(async () => {
    relay = await MiniRelay.start()
    pool = new SimplePool()
  })
  afterAll(async () => {
    pool.close([relay.url])
    await relay.close()
  })

  it('nevent path: parse → fetch → unwrap; revocation status via ephemeral delete', async () => {
    const { wrap, wrapEphemeralKey } = await createCapsule(author, {
      plaintext: 'secret',
      recipient: getPublicKey(recipientSk),
      round,
    })
    await Promise.allSettled(pool.publish([relay.url], wrap))

    const nevent = nip19.neventEncode({ id: wrap.id, relays: [relay.url] })
    const ref = parseInput(`nostr:${nevent}`)
    expect(ref.id).toBe(wrap.id)
    expect(ref.relays).toEqual([relay.url])

    const fetched = await fetchWrap(pool, ref.relays, ref.id)
    expect(fetched?.id).toBe(wrap.id)

    const { round: unwrappedRound } = await unwrapCapsule(recipient, fetched!)
    expect(unwrappedRound).toBe(round)

    // before revocation: not revoked
    expect(await checkRevoked(pool, [relay.url], fetched!)).toBe(false)

    // NIP-09 delete from the ephemeral key → deletion status flips
    const revocation = buildWrapRevocation(wrapEphemeralKey, wrap.id)
    expect(revocation.pubkey).toBe(wrap.pubkey) // only this way do relays honor the delete
    await Promise.allSettled(pool.publish([relay.url], revocation))
    expect(await checkRevoked(pool, [relay.url], fetched!)).toBe(true)
  }, 20_000)

  it('File path: lastpub-export.json and raw event JSON', async () => {
    const { wrap } = await createCapsule(author, {
      plaintext: 'offline',
      recipient: getPublicKey(recipientSk),
      round,
    })
    const exportFile = buildExport({
      wrap,
      job: { requestId: 'a'.repeat(64), tower: 'b'.repeat(64) },
      publishAt: now + 86400,
      relays: [relay.url],
    })
    expect(parseFile(JSON.stringify(exportFile)).id).toBe(wrap.id)
    expect(parseFile(JSON.stringify(wrap)).id).toBe(wrap.id)
    expect(() => parseFile('{"foo": 1}')).toThrow()
  })

  it('parseInput: raw hex ID and error cases', () => {
    expect(parseInput('c'.repeat(64))).toEqual({ id: 'c'.repeat(64), relays: [] })
    expect(() => parseInput('npub1invalid')).toThrow()
  })

  it('roundStatus: countdown math against timeForRound', () => {
    const locked = roundStatus(1000, 999)
    expect(locked.unlocked).toBe(false)
    expect(locked.readableAt).toBe(timeForRound(1000))
    expect(roundStatus(1000, 1000).unlocked).toBe(true)
    expect(roundStatus(1000, 1001).unlocked).toBe(true)
  })
})
