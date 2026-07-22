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

const DEFAULT_TOWER_NPUBS: string[] = (import.meta.env?.VITE_DEFAULT_TOWER_NPUB ?? '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean)

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

type OldMessage = { requestId?: string; placements?: unknown } & Record<string, unknown>

/**
 * Normalize any earlier persisted shape to the current model: a flat
 * single-message switch, or a `messages[]` switch keyed by a single
 * `towerPub`/`requestId`, both become `towerPubs[]` + per-message
 * `placements[]`.
 */
function migrateSwitch(raw: unknown): SwitchData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const towerPubs = Array.isArray(r.towerPubs)
    ? (r.towerPubs as string[])
    : r.towerPub
      ? [r.towerPub as string]
      : []

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
    towerPubs,
    interval: r.interval as number,
    lastCheckinAt: r.lastCheckinAt as number,
    publishAt: r.publishAt as number,
    messages: messages.map((m) => ({
      id: (m.id as string) ?? crypto.randomUUID(),
      recipient: m.recipient as string,
      placements: Array.isArray(m.placements)
        ? (m.placements as MessageData['placements'])
        : towerPubs.map((t) => ({ towerPub: t, requestId: (m.requestId as string) ?? '' })),
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
  const towerNpubs = Array.isArray(r.towerNpubs)
    ? (r.towerNpubs as string[])
    : r.towerNpub
      ? [r.towerNpub as string]
      : [...DEFAULT_TOWER_NPUBS]
  return { relays, towerNpubs }
}

export const storage = {
  loadSettings: (): Settings =>
    migrateSettings(read(KEYS.settings)) ?? {
      relays: [...DEFAULT_RELAYS],
      towerNpubs: [...DEFAULT_TOWER_NPUBS],
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
