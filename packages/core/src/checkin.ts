import { CHECKIN_TOLERANCE_SEC, KIND_CHECKIN } from './constants.js'
import { verifyWireEvent } from './wire.js'
import type { Signer } from './signer.js'
import type { CheckinVerdict, Event, VerifiedEvent } from './types.js'

/**
 * Canonical liveness signal, kind 1042 (spec §1.3).
 * Only kind/pubkey/created_at/sig are normative; tags are advisory.
 */
export async function createCheckin(
  signer: Signer,
  args?: { switchId?: string; now?: number },
): Promise<VerifiedEvent> {
  const tags: string[][] = [['t', 'lastpub-checkin']]
  if (args?.switchId) tags.push(['switch', args.switchId])
  return signer.signEvent({
    kind: KIND_CHECKIN,
    created_at: args?.now ?? Math.floor(Date.now() / 1000),
    content: '',
    tags,
  })
}

/**
 * Replay-protected check (spec §1.3/§3.3):
 * signature → kind → strict monotonicity → ±10-min tolerance → event ID dedup.
 */
export function verifyCheckin(
  e: Event,
  state: { lastCreatedAt: number; seenIds: Pick<Set<string>, 'has'>; now: number },
): CheckinVerdict {
  if (e.kind !== KIND_CHECKIN) return { ok: false, reason: 'kind' }
  if (!verifyWireEvent(e)) return { ok: false, reason: 'sig' }
  if (state.seenIds.has(e.id)) return { ok: false, reason: 'replay' }
  if (e.created_at <= state.lastCreatedAt) return { ok: false, reason: 'monotonic' }
  if (Math.abs(e.created_at - state.now) > CHECKIN_TOLERANCE_SEC) {
    return { ok: false, reason: 'tolerance' }
  }
  return { ok: true }
}
