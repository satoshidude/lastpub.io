import { verifyEvent } from 'nostr-tools/pure'
import type { Event } from './types.js'

/**
 * Signature check without trusting cached verdicts: nostr-tools marks
 * events produced by finalizeEvent with a verified symbol that an object
 * spread also copies — verifyEvent would then skip re-checking.
 * Verification inputs (tower, check-in) therefore go through a JSON copy.
 */
export function verifyWireEvent(e: Event): boolean {
  try {
    return verifyEvent(JSON.parse(JSON.stringify(e)) as Event)
  } catch {
    return false
  }
}
