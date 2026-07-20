import { Buffer } from 'buffer'
import { finalizeEvent, generateSecretKey, getEventHash, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { KIND_SEAL, KIND_WRAP, TIMESTAMP_RANDOMIZATION_SEC } from './constants.js'
import { LastpubError } from './errors.js'
import type { Signer } from './signer.js'
import type { Event, Rumor, VerifiedEvent } from './types.js'

/** NIP-59: randomize created_at up to 2 days into the past. */
export function randomizedNow(now = Math.floor(Date.now() / 1000)): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return now - (buf[0] % TIMESTAMP_RANDOMIZATION_SEC)
}

export function buildRumor(
  pubkey: string,
  template: { kind: number; created_at: number; content: string; tags: string[][] },
): Rumor {
  const rumor = { ...template, pubkey }
  return { ...rumor, id: getEventHash(rumor) }
}

/**
 * NIP-59 pipeline (spec §1.2): rumor → seal (kind 13, author-signed,
 * tags=[]) → gift wrap (kind 1059, ephemeral key, p tag).
 * Also returns the ephemeral secret: only it can later delete the published
 * 1059 via NIP-09 (revocation, §4.4), without exposing the author link.
 */
export async function wrapRumorDetailed(
  signer: Signer,
  rumor: Rumor,
  recipient: string,
): Promise<{ wrap: VerifiedEvent; ephemeralSecret: string }> {
  const seal = await signer.signEvent({
    kind: KIND_SEAL,
    created_at: randomizedNow(),
    tags: [],
    content: await signer.nip44Encrypt(recipient, JSON.stringify(rumor)),
  })
  const ephemeralKey = generateSecretKey()
  const conversationKey = nip44.getConversationKey(ephemeralKey, recipient)
  const wrap = finalizeEvent(
    {
      kind: KIND_WRAP,
      created_at: randomizedNow(),
      tags: [['p', recipient]],
      content: nip44.encrypt(JSON.stringify(seal), conversationKey),
    },
    ephemeralKey,
  )
  return { wrap, ephemeralSecret: Buffer.from(ephemeralKey).toString('hex') }
}

export async function wrapRumor(
  signer: Signer,
  rumor: Rumor,
  recipient: string,
): Promise<VerifiedEvent> {
  return (await wrapRumorDetailed(signer, rumor, recipient)).wrap
}

/**
 * Unwrapping at the recipient (spec §1.2): wrap → seal → rumor with all
 * mandatory NIP-59 checks. Capsule-specific checks are done by unwrapCapsule.
 */
export async function unwrapToRumor(
  signer: Signer,
  wrap: Event,
): Promise<{ rumor: Rumor; seal: Event }> {
  if (wrap.kind !== KIND_WRAP || !verifyEvent(wrap)) {
    throw new LastpubError('ERR_WRAP_INVALID', 'not a validly signed kind 1059 gift wrap')
  }
  const seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) as Event
  if (seal.kind !== KIND_SEAL || !verifyEvent(seal)) {
    throw new LastpubError('ERR_WRAP_INVALID', 'seal is not a validly signed kind 13 event')
  }
  if (seal.tags.length !== 0) {
    throw new LastpubError('ERR_SEAL_TAGS', 'seal must have empty tags')
  }
  const rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) as Rumor
  if (rumor.pubkey?.toLowerCase() !== seal.pubkey.toLowerCase()) {
    throw new LastpubError('ERR_PUBKEY_MISMATCH', 'rumor pubkey does not match seal pubkey')
  }
  const { id: _claimed, ...unsigned } = rumor
  const recomputed = getEventHash(unsigned as Rumor)
  if (rumor.id !== undefined && rumor.id !== recomputed) {
    throw new LastpubError('ERR_ID_MISMATCH', 'rumor id does not match recomputed id')
  }
  return { rumor: { ...rumor, id: recomputed }, seal }
}
