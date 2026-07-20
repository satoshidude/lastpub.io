import type { Event } from '@lastpub/core'

/** Web app persistence (localStorage): settings, switch state, journal. */

export type Settings = {
  relays: string[]
  towerNpub: string
}

/** A message: its own recipient, draft, capsule and 5905 job. */
export type MessageData = {
  id: string
  recipient: string // hex
  requestId: string
  wrap: Event
  /** Ephemeral secret of the current wrap — the only key for the NIP-09 revocation (§4.4). */
  wrapEphemeralKey: string
  draftWrap: Event
  /** Permanent after a false trigger: concealment toward this recipient broken (§4.4). */
  concealmentBroken: boolean
}

/** The switch: time model + check-in anchor. One switch per npub. */
export type SwitchData = {
  switchId: string
  /** Tower pubkey (hex), fixed at creation — independent of later settings changes. */
  towerPub: string
  interval: number
  grace: number
  lastCheckinAt: number
  publishAt: number
  roundTime: number
  messages: MessageData[]
}

/**
 * Journal for the success rule (§4.3): fully signed stage-5 events are
 * persisted before sending — a retry repeats only stage 5, without a new
 * NIP-07 cycle. One entry per message.
 */
export type PendingItem = {
  messageId: string
  recipient: string
  cancel: Event | null
  job: Event
  wrap: Event
  wrapEphemeralKey: string
  draftWrap: Event
}

export type PendingStage5 = {
  checkinAt: number
  publishAt: number
  roundTime: number
  items: PendingItem[]
}

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
    read<Settings>(KEYS.settings) ?? { relays: ['ws://127.0.0.1:7777'], towerNpub: '' },
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
