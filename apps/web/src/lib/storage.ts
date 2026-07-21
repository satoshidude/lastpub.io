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

const DEFAULT_TOWER_NPUB: string = import.meta.env?.VITE_DEFAULT_TOWER_NPUB ?? ''

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

/** Legacy state (flat, one message in the switch object) → new model. */
function migrateSwitch(raw: unknown): SwitchData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, never> & { [k: string]: unknown }
  if (Array.isArray(r.messages)) return raw as SwitchData
  if (!r.wrap) return null
  return {
    switchId: r.switchId as string,
    towerPub: (r.towerPub as string) ?? '',
    interval: r.interval as number,
    grace: r.grace as number,
    lastCheckinAt: r.lastCheckinAt as number,
    publishAt: r.publishAt as number,
    roundTime: r.roundTime as number,
    messages: [
      {
        id: crypto.randomUUID(),
        recipient: r.recipient as string,
        requestId: r.requestId as string,
        wrap: r.wrap as Event,
        wrapEphemeralKey: (r.wrapEphemeralKey as string) ?? '',
        draftWrap: r.draftWrap as Event,
        concealmentBroken: (r.concealmentBroken as boolean) ?? false,
      },
    ],
  }
}

export const storage = {
  loadSettings: (): Settings =>
    read<Settings>(KEYS.settings) ?? {
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
