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
  const sub = pool.subscribeMany(
    opts.relays,
    { kinds: [KIND_JOB, KIND_DELETE, KIND_WRAP], '#p': [towerPub] },
    {
      onevent: (e) => {
        tower
          .handleEvent(e)
          .then(publishResponses)
          .catch((err) => log(`handleEvent failed: ${err}`))
      },
    },
  )

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
      sub.close()
      pool.close(opts.relays)
      transport.close(opts.relays)
      db.close()
    },
  }
}
