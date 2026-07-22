import { SimplePool } from 'nostr-tools/pool'
import * as nip19 from 'nostr-tools/nip19'
import {
  DEFAULT_DRAND_URLS,
  KIND_DELETE,
  KIND_WRAP,
  QUICKNET,
  timeForRound,
  verifyCapsuleWrap,
  type Event,
  type LastpubExportV1,
} from '@lastpub/core'

/** Logic of the standalone decrypt page (spec §5), node-testable. */

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
]

export type WrapRef = { id: string; relays: string[] }

/** nevent (preferred) or raw 64-hex event ID (§5.2). */
export function parseInput(text: string): WrapRef {
  const trimmed = text.trim().replace(/^nostr:/, '')
  if (/^[0-9a-f]{64}$/.test(trimmed)) return { id: trimmed, relays: [] }
  const decoded = nip19.decode(trimmed)
  if (decoded.type !== 'nevent') throw new Error('Expected: nevent or event ID (hex)')
  return { id: decoded.data.id, relays: decoded.data.relays ?? [] }
}

/** lastpub-export.json or raw 1059 event JSON (offline path, §5.2). */
export function parseFile(json: string): Event {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('File is not JSON')
  }
  const asExport = parsed as LastpubExportV1
  const wrap =
    asExport?.type === 'lastpub-export' && asExport.capsule?.wrap
      ? asExport.capsule.wrap
      : (parsed as Event)
  const verdict = verifyCapsuleWrap(wrap)
  if (!verdict.ok) throw new Error(`Not a valid capsule wrap: ${verdict.reason}`)
  return wrap
}

export async function fetchWrap(
  pool: SimplePool,
  relays: string[],
  id: string,
): Promise<Event | null> {
  const e = await pool.get(relays, { kinds: [KIND_WRAP], ids: [id] })
  if (!e) return null
  const verdict = verifyCapsuleWrap(e)
  if (!verdict.ok) throw new Error(`Relay returned an invalid wrap: ${verdict.reason}`)
  return e
}

/**
 * Deletion status (§5.3): does a NIP-09 delete from the wrap signer (ephemeral
 * key) exist? Display only, does not suppress decryption — a published capsule
 * stays readable regardless.
 */
export async function checkRevoked(
  pool: SimplePool,
  relays: string[],
  wrap: Event,
): Promise<boolean> {
  const e = await pool
    .get(relays, { kinds: [KIND_DELETE], authors: [wrap.pubkey], '#e': [wrap.id] })
    .catch(() => null)
  return !!e
}

/** Current quicknet round via HTTP (display countdown; decrypt verifies itself). */
export async function fetchCurrentRound(urls: string[] = DEFAULT_DRAND_URLS): Promise<number> {
  let lastError: unknown
  for (const url of urls) {
    try {
      const res = await fetch(`${url}/${QUICKNET.chainHash}/public/latest`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { round: number }
      if (!Number.isFinite(body.round)) throw new Error('malformed beacon')
      return body.round
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`no drand endpoint reachable: ${lastError}`)
}

export type RoundStatus = { unlocked: boolean; readableAt: number }

export function roundStatus(capsuleRound: number, currentRound: number): RoundStatus {
  return {
    unlocked: currentRound >= capsuleRound,
    readableAt: timeForRound(capsuleRound),
  }
}
