import type { Event } from '@lastpub/core'
import type {
  MessageData,
  PendingStage5,
  Settings,
  StorageAdapter,
  SwitchData,
} from '@lastpub/client'

/** Web app persistence (localStorage): settings, switch state, journal. */

// Domain types live in @lastpub/client; re-exported so existing imports of
// `./storage.js` keep resolving.
export type { MessageData, PendingItem, PendingStage5, Settings, SwitchData } from '@lastpub/client'

/**
 * Defaults for a fresh visitor, baked in at build time so a deployment can
 * point at its own relay and tower without patching source. Both fall back to
 * the local dev stack (see scripts/dev-stack.mjs). Settings the user saves
 * always win — these only fill an empty localStorage.
 */
const DEFAULT_RELAYS: string[] = (
  import.meta.env?.VITE_DEFAULT_RELAYS ?? 'ws://127.0.0.1:7777'
)
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean)

const DEFAULT_TOWER_NPUB: string =
  (import.meta.env?.VITE_DEFAULT_TOWER_NPUB ?? '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean)[0] ?? ''

const KEYS = { settings: 'lastpub.settings', switch: 'lastpub.switch', pending: 'lastpub.pending' }

function read<T>(key: string): T | null {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

type OldMessage = {
  requestId?: string
  placements?: unknown
  placement?: unknown
} & Record<string, unknown>

/**
 * Normalize any earlier persisted shape to the current single-tower model. A
 * flat single-message switch, or a `messages[]` switch keyed by an array of
 * towers (`towerPubs[]` / per-message `placements[]`, from the multi-tower
 * era), collapses to a single `towerPub` + per-message `placement`: the first
 * tower is kept. A genuine multi-tower switch loses its extra placements here —
 * those towers keep their own jobs until they fire or are cancelled by a
 * check-in, so migrate by checking in once before upgrading if that matters.
 */
function firstTower(r: Record<string, unknown>): string {
  if (Array.isArray(r.towerPubs) && r.towerPubs.length) return r.towerPubs[0] as string
  if (typeof r.towerPub === 'string') return r.towerPub
  return ''
}

function migratePlacement(m: OldMessage, towerPub: string): MessageData['placement'] {
  if (m.placement && typeof m.placement === 'object') {
    return m.placement as MessageData['placement']
  }
  if (Array.isArray(m.placements) && m.placements.length) {
    return (m.placements as MessageData['placement'][])[0]
  }
  return { towerPub, requestId: (m.requestId as string) ?? '' }
}

function migrateSwitch(raw: unknown): SwitchData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const towerPub = firstTower(r)

  let messages: OldMessage[]
  if (Array.isArray(r.messages)) {
    messages = r.messages as OldMessage[]
  } else if (r.wrap) {
    // oldest flat shape: one message inlined on the switch
    messages = [
      {
        recipient: r.recipient,
        requestId: r.requestId,
        wrap: r.wrap,
        wrapEphemeralKey: r.wrapEphemeralKey,
        draftWrap: r.draftWrap,
        concealmentBroken: r.concealmentBroken,
      } as OldMessage,
    ]
  } else {
    return null
  }

  return {
    switchId: r.switchId as string,
    towerPub,
    interval: r.interval as number,
    lastCheckinAt: r.lastCheckinAt as number,
    publishAt: r.publishAt as number,
    messages: messages.map((m) => ({
      id: (m.id as string) ?? crypto.randomUUID(),
      recipient: m.recipient as string,
      placement: migratePlacement(m, towerPub),
      wrap: m.wrap as Event,
      wrapEphemeralKey: (m.wrapEphemeralKey as string) ?? '',
      draftWrap: m.draftWrap as Event,
      concealmentBroken: (m.concealmentBroken as boolean) ?? false,
    })),
  }
}

function migrateSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const relays = Array.isArray(r.relays) ? (r.relays as string[]) : [...DEFAULT_RELAYS]
  const towerNpub =
    typeof r.towerNpub === 'string'
      ? r.towerNpub
      : Array.isArray(r.towerNpubs) && r.towerNpubs.length
        ? (r.towerNpubs[0] as string)
        : DEFAULT_TOWER_NPUB
  return { relays, towerNpub }
}

export const storage = {
  loadSettings: (): Settings =>
    migrateSettings(read(KEYS.settings)) ?? {
      relays: [...DEFAULT_RELAYS],
      towerNpub: DEFAULT_TOWER_NPUB,
    },
  saveSettings: (s: Settings) => localStorage.setItem(KEYS.settings, JSON.stringify(s)),
  loadSwitch: (): SwitchData | null => migrateSwitch(read(KEYS.switch)),
  saveSwitch: (s: SwitchData) => localStorage.setItem(KEYS.switch, JSON.stringify(s)),
  clearSwitch: () => localStorage.removeItem(KEYS.switch),
  loadPending: (): PendingStage5 | null => {
    const p = read<PendingStage5>(KEYS.pending)
    return p && Array.isArray(p.items) ? p : null // discard legacy journal without items
  },
  savePending: (p: PendingStage5) => localStorage.setItem(KEYS.pending, JSON.stringify(p)),
  clearPending: () => localStorage.removeItem(KEYS.pending),
}
