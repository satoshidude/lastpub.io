import { useWebSocketImplementation, SimplePool } from 'nostr-tools/pool'
import WebSocket from 'ws'
import * as nip19 from 'nostr-tools/nip19'
import { KIND_DELETE, KIND_JOB, KIND_WRAP, type Event, type Signer } from '@lastpub/core'
import { Tower } from './tower.js'
import { TowerDb } from './db.js'
import { PoolTransport } from './transport.js'

export type RunOptions = {
  signer: Signer
  /** Relays for ingress + feedback publication. */
  relays: string[]
  /** Broadcast fallback set (§3.4). */
  fallbackRelays: string[]
  dbPath?: string
  tickMs?: number
  /**
   * How often to re-establish the ingress subscription (ms). A single
   * long-lived subscription silently dies when a public relay drops the
   * connection and the pool fails to reconnect; periodically re-subscribing
   * forces the pool to reconnect any dropped relay. 0 disables it.
   */
  resubscribeMs?: number
  log?: (msg: string) => void
}

export type RunningTower = {
  towerPub: string
  db: TowerDb
  stop(): Promise<void>
}

/**
 * Operational wiring (design doc §3): relay subscription on p-tagged
 * 5905/5/1059 events addressed to the tower npub + trigger tick.
 */
export async function startTower(opts: RunOptions): Promise<RunningTower> {
  useWebSocketImplementation(WebSocket)
  const log = opts.log ?? (() => {})

  const db = new TowerDb(opts.dbPath ?? ':memory:')
  const transport = new PoolTransport(opts.relays)
  const tower = new Tower({
    signer: opts.signer,
    db,
    transport,
    fallbackRelays: opts.fallbackRelays,
  })

  const towerPub = await opts.signer.getPublicKey()
  log(`lastpub tower ${nip19.npubEncode(towerPub)} listening on ${opts.relays.join(', ')}`)

  const publishResponses = async (events: Event[]): Promise<void> => {
    for (const e of events) {
      await transport.publish(e, opts.relays).catch((err) => log(`publish failed: ${err}`))
    }
  }

  const pool = new SimplePool()

  // Ingress events are re-delivered whenever the subscription is renewed (and
  // by relays that hold history), so dedupe before handing them to the tower:
  // otherwise every renewal would re-emit 7000 feedback for known jobs. The
  // tower's own idempotency still covers a process restart; this only spares
  // the relays needless duplicate feedback within one process.
  const handled = new Set<string>()
  const resubscribeMs = opts.resubscribeMs ?? 90_000
  // Bound how far back each (re)subscribe fetches. It must exceed NIP-59's
  // 2-day gift-wrap back-dating, or check-in wraps (kind 1059, timestamped up
  // to 2 days in the past for privacy) would be filtered out. 3 days covers it
  // with margin while keeping the per-renewal refetch bounded.
  const lookbackSec = 3 * 86_400

  const onevent = (e: Event): void => {
    if (handled.has(e.id)) return
    handled.add(e.id)
    if (handled.size > 50_000) handled.clear() // bound memory; a rare re-feedback is harmless
    tower
      .handleEvent(e)
      .then(publishResponses)
      .catch((err) => log(`handleEvent failed: ${err}`))
  }

  const subscribe = (): { close(): void } =>
    pool.subscribeMany(
      opts.relays,
      {
        kinds: [KIND_JOB, KIND_DELETE, KIND_WRAP],
        '#p': [towerPub],
        since: Math.floor(Date.now() / 1000) - lookbackSec,
      },
      { onevent },
    )

  let sub = subscribe()
  const resubTimer =
    resubscribeMs > 0
      ? setInterval(() => {
          sub.close()
          sub = subscribe() // forces the pool to reconnect any dropped relay
        }, resubscribeMs)
      : undefined

  const timer = setInterval(() => {
    tower
      .tick()
      .then(publishResponses)
      .catch((err) => log(`tick failed: ${err}`))
  }, opts.tickMs ?? 1000)

  return {
    towerPub,
    db,
    stop: async () => {
      clearInterval(timer)
      if (resubTimer) clearInterval(resubTimer)
      sub.close()
      pool.close(opts.relays)
      transport.close(opts.relays)
      db.close()
    },
  }
}
