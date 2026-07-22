import { Buffer } from 'buffer'
import { finalizeEvent } from 'nostr-tools/pure'
import { KIND_CAPSULE, KIND_DELETE, KIND_WRAP, MAX_CONTENT_BYTES } from './constants.js'
import { verifyWireEvent } from './wire.js'
import { LastpubError } from './errors.js'
import { assertSingleTlockStanza, base64ToBytes, bytesToBase64 } from './age.js'
import { buildRumor, unwrapToRumor, wrapRumorDetailed } from './giftwrap.js'
import { getDefaultTlockEngine, type TlockEngine } from './tlock.js'
import { computeSchedule, timeForRound } from './schedule.js'
import { readDraftWrap } from './draft.js'
import type { Signer } from './signer.js'
import type { Event, Rumor, VerifiedEvent, WrapVerdict } from './types.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Build a capsule (spec §1.2): plaintext → tlock → rumor 1041 → seal → wrap.
 */
export async function createCapsule(
  signer: Signer,
  args: {
    plaintext: string
    recipient: string
    round: number
    now?: number
    tlock?: TlockEngine
  },
): Promise<{ wrap: VerifiedEvent; rumorId: string; wrapEphemeralKey: string }> {
  const tlock = args.tlock ?? getDefaultTlockEngine()
  const now = args.now ?? Math.floor(Date.now() / 1000)
  if (timeForRound(args.round) <= now) {
    throw new LastpubError('ERR_ROUND_IN_PAST', `round ${args.round} is not in the future`)
  }
  const ageBinary = await tlock.encrypt(args.round, textEncoder.encode(args.plaintext))
  if (ageBinary.length > MAX_CONTENT_BYTES) {
    throw new LastpubError('ERR_SIZE_LIMIT', `capsule content ${ageBinary.length} B > 64 KiB`)
  }
  assertSingleTlockStanza(ageBinary, { chainHash: tlock.chainHash, round: String(args.round) })
  const rumor = buildRumor(await signer.getPublicKey(), {
    kind: KIND_CAPSULE,
    created_at: now,
    content: bytesToBase64(ageBinary),
    tags: [
      ['tlock', tlock.chainHash, String(args.round)],
      ['alt', 'lastpub time capsule'],
    ],
  })
  const { wrap, ephemeralSecret } = await wrapRumorDetailed(signer, rumor, args.recipient)
  return { wrap, rumorId: rumor.id, wrapEphemeralKey: ephemeralSecret }
}

/**
 * Check-in stages 2–4 (spec §4.3): read draft, compute new round,
 * rebuild capsule (re-encryption on every check-in).
 */
export async function renewCapsule(
  signer: Signer,
  args: {
    draftWrap: Event
    lastCheckinAt: number
    now?: number
    tlock?: TlockEngine
  },
): Promise<{
  wrap: VerifiedEvent
  rumorId: string
  wrapEphemeralKey: string
  round: number
  publishAt: number
}> {
  const draft = await readDraftWrap(signer, args.draftWrap)
  const schedule = computeSchedule(args.lastCheckinAt, draft.interval)
  const { wrap, rumorId, wrapEphemeralKey } = await createCapsule(signer, {
    plaintext: draft.message,
    recipient: draft.recipient,
    round: schedule.round,
    now: args.now,
    tlock: args.tlock,
  })
  return { wrap, rumorId, wrapEphemeralKey, round: schedule.round, publishAt: schedule.publishAt }
}

/**
 * Structural check of a wrap without a key (tower side, spec §3.2).
 * Content stays invisible — only the 1059 envelope is checked.
 */
export function verifyCapsuleWrap(e: Event): WrapVerdict {
  if (e.kind !== KIND_WRAP) return { ok: false, reason: `kind ${e.kind}, expected 1059` }
  if (!e.tags.some((t) => t[0] === 'p' && typeof t[1] === 'string' && t[1].length === 64)) {
    return { ok: false, reason: 'missing p tag' }
  }
  if (!e.content) return { ok: false, reason: 'empty content' }
  if (!verifyWireEvent(e)) return { ok: false, reason: 'invalid signature' }
  return { ok: true }
}

/**
 * Unwrapping at the recipient (spec §5.3) incl. all Shugur checks
 * on the inner 1041.
 */
export async function unwrapCapsule(
  signer: Signer,
  wrap: Event,
): Promise<{ rumor: Rumor; round: number; chain: string }> {
  const { rumor } = await unwrapToRumor(signer, wrap)
  if (rumor.kind !== KIND_CAPSULE) {
    throw new LastpubError('ERR_WRAP_INVALID', `inner rumor kind ${rumor.kind}, expected 1041`)
  }
  if (rumor.tags.some((t) => t[0] === 'p')) {
    throw new LastpubError('ERR_RUMOR_PTAG', 'inner 1041 must not contain p tags')
  }
  const tlockTags = rumor.tags.filter((t) => t[0] === 'tlock')
  if (tlockTags.length !== 1) {
    throw new LastpubError('ERR_TLOCK_TAG', `expected exactly one tlock tag, got ${tlockTags.length}`)
  }
  const [, chain, round] = tlockTags[0]
  if (!/^[0-9a-f]{64}$/.test(chain) || !/^[1-9][0-9]{0,18}$/.test(round)) {
    throw new LastpubError('ERR_TLOCK_TAG', 'malformed tlock tag values')
  }
  const ageBinary = base64ToBytes(rumor.content)
  if (ageBinary.length > MAX_CONTENT_BYTES) {
    throw new LastpubError('ERR_SIZE_LIMIT', `decoded content ${ageBinary.length} B > 64 KiB`)
  }
  assertSingleTlockStanza(ageBinary, { chainHash: chain, round })
  return { rumor, round: Number(round), chain }
}

/**
 * NIP-09 delete request on a published 1059, signed with the locally retained
 * ephemeral key of the wrap — only it can delete the 1059, without exposing the
 * author link. Best-effort relay cleanup; it cannot make a readable capsule
 * unreadable, and the decrypt page surfaces it as a display-only status (§5.3).
 */
export function buildWrapRevocation(
  wrapEphemeralKey: string,
  wrapId: string,
  now = Math.floor(Date.now() / 1000),
): VerifiedEvent {
  return finalizeEvent(
    {
      kind: KIND_DELETE,
      created_at: now,
      content: 'revoked',
      tags: [
        ['e', wrapId],
        ['k', String(KIND_WRAP)],
      ],
    },
    new Uint8Array(Buffer.from(wrapEphemeralKey, 'hex')),
  )
}

/**
 * Decryption (spec §5.3): fetch drand beacon + BLS-verify
 * (handled by tlock-js), then age-decrypt. Never against the local clock.
 */
export async function decryptCapsule(
  rumor: Rumor,
  opts?: { tlock?: TlockEngine },
): Promise<string> {
  const tlock = opts?.tlock ?? getDefaultTlockEngine()
  const tlockTag = rumor.tags.find((t) => t[0] === 'tlock')
  if (!tlockTag) throw new LastpubError('ERR_TLOCK_TAG', 'missing tlock tag')
  if (tlockTag[1] !== tlock.chainHash) {
    throw new LastpubError('ERR_TLOCK_TAG', `capsule chain ${tlockTag[1]} does not match engine chain ${tlock.chainHash}`)
  }
  const plain = await tlock.decrypt(base64ToBytes(rumor.content))
  return textDecoder.decode(plain)
}
