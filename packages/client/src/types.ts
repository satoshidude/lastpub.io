import type { Event } from '@lastpub/core'

/** Relay set + tower the client talks to. */
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

/**
 * Persistence the client writes through. The host provides it — localStorage
 * in the browser, a Map in tests, a file or DB elsewhere. Reads (hydrating the
 * dashboard, loading settings) are the host's concern; the client only writes
 * the switch state and the stage-5 journal.
 */
export interface StorageAdapter {
  saveSwitch(s: SwitchData): void
  savePending(p: PendingStage5): void
  clearPending(): void
  clearSwitch(): void
}

/** Client behaviour toggles. */
export type ClientOptions = {
  /**
   * Allow more than one message per switch. Off by default: the minimal
   * reference client is single-message by product choice. The protocol and
   * tower support multiple (each message gets its own slot, §3.2), so a richer
   * client can turn this on.
   */
  allowMultipleMessages?: boolean
}
