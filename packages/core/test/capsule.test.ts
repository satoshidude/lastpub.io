import { describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import {
  createCapsule,
  decryptCapsule,
  unwrapCapsule,
  verifyCapsuleWrap,
} from '../src/capsule.js'
import { buildRumor, wrapRumor, unwrapToRumor } from '../src/giftwrap.js'
import { bytesToBase64 } from '../src/age.js'
import { QUICKNET } from '../src/constants.js'
import { roundForTime } from '../src/schedule.js'
import { LastpubError } from '../src/errors.js'
import { FakeTlockEngine, newSigner } from './helpers.js'

const now = 1_800_000_000
const round = roundForTime(now + 86400)
const tlock = new FakeTlockEngine()

async function makeCapsule(plaintext = 'secret message') {
  const author = newSigner()
  const recipient = newSigner()
  const recipientPub = getPublicKey(recipient.sk)
  const { wrap, rumorId } = await createCapsule(author.signer, {
    plaintext,
    recipient: recipientPub,
    round,
    now,
    tlock,
  })
  return { author, recipient, recipientPub, wrap, rumorId, plaintext }
}

describe('createCapsule → unwrapCapsule → decryptCapsule (round trip)', () => {
  it('recipient can unwrap and (round reached) decrypt', async () => {
    const { recipient, wrap, plaintext, author } = await makeCapsule()
    expect(verifyCapsuleWrap(wrap)).toEqual({ ok: true })
    // wrap is ephemeral-signed, never by the author
    expect(wrap.pubkey).not.toBe(getPublicKey(author.sk))

    const { rumor, round: r, chain } = await unwrapCapsule(recipient.signer, wrap)
    expect(r).toBe(round)
    expect(chain).toBe(QUICKNET.chainHash)
    expect(rumor.pubkey).toBe(getPublicKey(author.sk))

    const plain = await decryptCapsule(rumor, { tlock })
    expect(plain).toBe(plaintext)
  })

  it('before the round: ERR_TOO_EARLY', async () => {
    const early = new FakeTlockEngine(QUICKNET.chainHash, round - 1)
    const { recipient, wrap } = await makeCapsule()
    const { rumor } = await unwrapCapsule(recipient.signer, wrap)
    await expect(decryptCapsule(rumor, { tlock: early })).rejects.toMatchObject({
      code: 'ERR_TOO_EARLY',
    })
  })

  it('a third party without the recipient key cannot unwrap', async () => {
    const { wrap } = await makeCapsule()
    const stranger = newSigner()
    await expect(unwrapCapsule(stranger.signer, wrap)).rejects.toThrow()
  })

  it('round in the past: ERR_ROUND_IN_PAST on build', async () => {
    const { signer } = newSigner()
    await expect(
      createCapsule(signer, {
        plaintext: 'x',
        recipient: getPublicKey(newSigner().sk),
        round: roundForTime(now - 86400),
        now,
        tlock,
      }),
    ).rejects.toMatchObject({ code: 'ERR_ROUND_IN_PAST' })
  })
})

describe('negative vectors (Shugur rules)', () => {
  async function craftWrap(
    mutateRumor: (rumor: ReturnType<typeof buildRumor>) => ReturnType<typeof buildRumor>,
  ) {
    const author = newSigner()
    const recipient = newSigner()
    const recipientPub = getPublicKey(recipient.sk)
    const age = await tlock.encrypt(round, new TextEncoder().encode('x'))
    let rumor = buildRumor(getPublicKey(author.sk), {
      kind: 1041,
      created_at: now,
      content: bytesToBase64(age),
      tags: [['tlock', QUICKNET.chainHash, String(round)]],
    })
    rumor = mutateRumor(rumor)
    const wrap = await wrapRumor(author.signer, rumor, recipientPub)
    return { wrap, recipient }
  }

  function rehash(r: ReturnType<typeof buildRumor>) {
    const { id: _, ...rest } = r
    return buildRumor(r.pubkey, rest as never)
  }

  it('p tag in the rumor: ERR_RUMOR_PTAG', async () => {
    const { wrap, recipient } = await craftWrap((r) =>
      rehash({ ...r, tags: [...r.tags, ['p', r.pubkey]] }),
    )
    await expect(unwrapCapsule(recipient.signer, wrap)).rejects.toMatchObject({
      code: 'ERR_RUMOR_PTAG',
    })
  })

  it('no tlock tag: ERR_TLOCK_TAG', async () => {
    const { wrap, recipient } = await craftWrap((r) => rehash({ ...r, tags: [] }))
    await expect(unwrapCapsule(recipient.signer, wrap)).rejects.toMatchObject({
      code: 'ERR_TLOCK_TAG',
    })
  })

  it('two tlock tags: ERR_TLOCK_TAG', async () => {
    const { wrap, recipient } = await craftWrap((r) =>
      rehash({ ...r, tags: [...r.tags, ['tlock', QUICKNET.chainHash, String(round + 1)]] }),
    )
    await expect(unwrapCapsule(recipient.signer, wrap)).rejects.toMatchObject({
      code: 'ERR_TLOCK_TAG',
    })
  })

  it('tag/stanza mismatch (round tampered with): ERR_TLOCK_TAG', async () => {
    const { wrap, recipient } = await craftWrap((r) =>
      rehash({ ...r, tags: [['tlock', QUICKNET.chainHash, String(round + 1)]] }),
    )
    await expect(unwrapCapsule(recipient.signer, wrap)).rejects.toMatchObject({
      code: 'ERR_TLOCK_TAG',
    })
  })

  it('armored age: ERR_TLOCK_TAG', async () => {
    const armored = new TextEncoder().encode(
      '-----BEGIN AGE ENCRYPTED FILE-----\nYWJj\n-----END AGE ENCRYPTED FILE-----\n',
    )
    const { wrap, recipient } = await craftWrap((r) =>
      rehash({ ...r, content: bytesToBase64(armored) }),
    )
    await expect(unwrapCapsule(recipient.signer, wrap)).rejects.toMatchObject({
      code: 'ERR_TLOCK_TAG',
    })
  })

  it('content > 64 KiB decoded: ERR_SIZE_LIMIT', async () => {
    const big = new Uint8Array(64 * 1024 + 1)
    const { wrap, recipient } = await craftWrap((r) =>
      rehash({ ...r, content: bytesToBase64(big) }),
    )
    await expect(unwrapCapsule(recipient.signer, wrap)).rejects.toMatchObject({
      code: 'ERR_SIZE_LIMIT',
    })
  })

  it('tampered rumor id: ERR_ID_MISMATCH', async () => {
    const { wrap, recipient } = await craftWrap((r) => ({
      ...r,
      id: '0'.repeat(64),
    }))
    await expect(unwrapCapsule(recipient.signer, wrap)).rejects.toMatchObject({
      code: 'ERR_ID_MISMATCH',
    })
  })

  it('seal with tags: ERR_SEAL_TAGS', async () => {
    // build seal manually with non-empty tags
    const author = newSigner()
    const recipient = newSigner()
    const recipientPub = getPublicKey(recipient.sk)
    const rumor = buildRumor(getPublicKey(author.sk), {
      kind: 1041,
      created_at: now,
      content: 'x',
      tags: [],
    })
    const seal = await author.signer.signEvent({
      kind: 13,
      created_at: now,
      tags: [['p', recipientPub]],
      content: await author.signer.nip44Encrypt(recipientPub, JSON.stringify(rumor)),
    })
    const { generateSecretKey, finalizeEvent } = await import('nostr-tools/pure')
    const nip44 = await import('nostr-tools/nip44')
    const eph = generateSecretKey()
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: now,
        tags: [['p', recipientPub]],
        content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(eph, recipientPub)),
      },
      eph,
    )
    await expect(unwrapToRumor(recipient.signer, wrap)).rejects.toMatchObject({
      code: 'ERR_SEAL_TAGS',
    })
  })

  it('LastpubError carries code and name', () => {
    const e = new LastpubError('ERR_TLOCK_TAG', 'x')
    expect(e.name).toBe('LastpubError')
    expect(e.code).toBe('ERR_TLOCK_TAG')
  })
})

describe('renewCapsule', () => {
  it('produces new round + new wrap, same plaintext stays readable', async () => {
    const { renewCapsule } = await import('../src/capsule.js')
    const { createDraftWrap } = await import('../src/draft.js')
    const author = newSigner()
    const recipient = newSigner()
    const recipientPub = getPublicKey(recipient.sk)
    const draftWrap = await createDraftWrap(author.signer, {
      switch_id: 'test-switch',
      message: 'my message',
      recipient: recipientPub,
      interval: 30 * 86400,
      updated_at: now,
    })

    const a = await renewCapsule(author.signer, { draftWrap, lastCheckinAt: now, now, tlock })
    const b = await renewCapsule(author.signer, {
      draftWrap,
      lastCheckinAt: now + 86400,
      now,
      tlock,
    })

    expect(b.round).toBeGreaterThan(a.round)
    expect(b.wrap.id).not.toBe(a.wrap.id)
    expect(b.publishAt - (now + 86400)).toBe(30 * 86400)

    // both capsules stay independently decryptable (burned ≠ unusable)
    for (const c of [a, b]) {
      const { rumor } = await unwrapCapsule(recipient.signer, c.wrap)
      expect(await decryptCapsule(rumor, { tlock })).toBe('my message')
    }
  })
})
