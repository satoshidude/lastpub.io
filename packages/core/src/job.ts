import { KIND_DELETE, KIND_JOB } from './constants.js'
import { LastpubError } from './errors.js'
import { verifyCapsuleWrap } from './capsule.js'
import type { Signer } from './signer.js'
import type { Event, VerifiedEvent } from './types.js'

/**
 * 5905 job request (spec §1.4): i/param tags NIP-44-encrypted in the
 * content (lastpub convention; registry doc uses NIP-04), ["encrypted"] marker.
 */
export async function buildJobRequest(
  signer: Signer,
  args: { wrap: Event; publishAt: number; relays: string[]; tower: string; slot?: string },
): Promise<VerifiedEvent> {
  const payloadTags = [
    ['i', JSON.stringify(args.wrap), 'text'],
    ['param', 'relays', ...args.relays],
    ['param', 'publish_at', String(args.publishAt)],
    // Slot: stable per-message identifier so a switch can carry several
    // messages, each its own withheld job. Omitted → default slot '', which
    // gives the classic one-job-per-author behaviour. Encrypted to the tower.
    ...(args.slot ? [['param', 'slot', args.slot]] : []),
  ]
  return signer.signEvent({
    kind: KIND_JOB,
    created_at: Math.floor(Date.now() / 1000),
    content: await signer.nip44Encrypt(args.tower, JSON.stringify(payloadTags)),
    tags: [
      ['p', args.tower],
      ['encrypted'],
    ],
  })
}

export type JobRequest = {
  author: string
  requestId: string
  wrap: Event
  publishAt: number
  relays: string[]
  /** Per-message slot; '' when the client sends a single message per author. */
  slot: string
}

/** Tower side (spec §3.2): decrypt request + check structure. */
export async function decryptJobRequest(towerSigner: Signer, e: Event): Promise<JobRequest> {
  if (e.kind !== KIND_JOB) {
    throw new LastpubError('ERR_WRAP_INVALID', `kind ${e.kind}, expected 5905`)
  }
  let payloadTags: string[][]
  try {
    payloadTags = JSON.parse(await towerSigner.nip44Decrypt(e.pubkey, e.content))
  } catch (err) {
    throw new LastpubError('ERR_WRAP_INVALID', 'job request content is not NIP-44 payload tags', {
      cause: err,
    })
  }
  const iTag = payloadTags.find((t) => t[0] === 'i')
  const relaysTag = payloadTags.find((t) => t[0] === 'param' && t[1] === 'relays')
  const publishAtTag = payloadTags.find((t) => t[0] === 'param' && t[1] === 'publish_at')
  const slotTag = payloadTags.find((t) => t[0] === 'param' && t[1] === 'slot')
  if (!iTag || !publishAtTag) {
    throw new LastpubError('ERR_WRAP_INVALID', 'job request missing i or publish_at')
  }
  const wrap = JSON.parse(iTag[1]) as Event
  const verdict = verifyCapsuleWrap(wrap)
  if (!verdict.ok) {
    throw new LastpubError('ERR_WRAP_INVALID', `embedded wrap invalid: ${verdict.reason}`)
  }
  const publishAt = Number(publishAtTag[2])
  if (!Number.isFinite(publishAt) || publishAt <= 0) {
    throw new LastpubError('ERR_WRAP_INVALID', 'publish_at is not a valid unix timestamp')
  }
  return {
    author: e.pubkey,
    requestId: e.id,
    wrap,
    publishAt,
    relays: relaysTag ? relaysTag.slice(2) : [],
    slot: slotTag?.[2] ?? '',
  }
}

/**
 * Cancellation (spec §1.4/§3.5): NIP-09 kind 5 on the 5905 request event.
 * The p tag addresses the tower — its subscription filters on #p.
 */
export async function buildCancel(
  signer: Signer,
  jobRequestId: string,
  tower: string,
): Promise<VerifiedEvent> {
  return signer.signEvent({
    kind: KIND_DELETE,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['e', jobRequestId],
      ['k', String(KIND_JOB)],
      ['p', tower],
    ],
  })
}
