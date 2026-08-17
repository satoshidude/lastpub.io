import { SimplePool } from 'nostr-tools/pool'
import { KIND_DM_RELAYS, type Event } from '@lastpub/core'

/**
 * The tower's relay layer, injectable for tests (design doc §3.4).
 */
export interface Transport {
  /** Broadcasts the event; returns the number of relay OKs. */
  publish(event: Event, relays: string[]): Promise<number>
  /** Resolves the pubkey's kind-10050 DM relay list ([] if none). */
  fetchDmRelays(pubkey: string): Promise<string[]>
}

export class PoolTransport implements Transport {
  private readonly pool = new SimplePool()

  constructor(private readonly lookupRelays: string[]) {}

  async publish(event: Event, relays: string[]): Promise<number> {
    const results = await Promise.allSettled(this.pool.publish(relays, event))
    return results.filter((r) => r.status === 'fulfilled').length
  }

  async fetchDmRelays(pubkey: string): Promise<string[]> {
    try {
      const e = await this.pool.get(this.lookupRelays, {
        kinds: [KIND_DM_RELAYS],
        authors: [pubkey],
      })
      if (!e) return []
      return e.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1])
    } catch {
      return []
    }
  }

  close(relays: string[]): void {
    this.pool.close(relays)
  }
}
