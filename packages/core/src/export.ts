import * as nip19 from 'nostr-tools/nip19'
import { QUICKNET } from './constants.js'
import type { Event, LastpubExportV1 } from './types.js'

/**
 * Ciphertext export (spec §4.5): covers the threat "scheduler
 * never broadcasts" — the wrap can be broadcast from the file itself and
 * opened directly on the decrypt page.
 */
export function buildExport(args: {
  wrap: Event
  jobRequestId: string
  tower: string
  publishAt: number
  relays: string[]
  draftWrap?: Event
  now?: number
}): LastpubExportV1 {
  return {
    v: 1,
    type: 'lastpub-export',
    exported_at: args.now ?? Math.floor(Date.now() / 1000),
    capsule: {
      wrap: args.wrap,
      nevent: nip19.neventEncode({
        id: args.wrap.id,
        relays: args.relays.slice(0, 4),
        author: args.wrap.pubkey,
      }),
    },
    job: { request_id: args.jobRequestId, tower: args.tower, publish_at: args.publishAt },
    ...(args.draftWrap ? { draft_wrap: args.draftWrap } : {}),
    drand: { chain: QUICKNET.chainHash, genesis: QUICKNET.genesis, period: QUICKNET.period },
  }
}
