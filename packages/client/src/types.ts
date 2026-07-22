import type { Event } from '@lastpub/core'

/** Relay set + the towers the client talks to (more than one = redundancy). */
export type Settings = {
  relays: string[]
  towerNpubs: string[]
}

/** Where one message's capsule is scheduled: a request id per tower. */
export type Placement = {
  towerPub: string // hex
  requestId: string
}

/** A message: its own recipient, draft, capsule and a 5905 job per tower. */
export type MessageData = {
  id: string
  recipient: string // hex
  /** One scheduled job per tower (redundancy): if any tower survives, it fires. */
  placements: Placement[]
  wrap: Event
  /** Ephemeral secret of the current wrap (retained; wraps sign with a throwaway key). */
  wrapEphemeralKey: string
  draftWrap: Event
  /** Once the deadline passes, the message is public and readable: concealment broken. */
  concealmentBroken: boolean
}

/** The switch: time model + check-in anchor. One switch per npub. */
export type SwitchData = {
  switchId: string
  /** Tower pubkeys (hex), fixed at creation — independent of later settings changes. */
  towerPubs: string[]
  interval: number
  lastCheckinAt: number
  publishAt: number
  messages: MessageData[]
}

/** A signed job (+ optional cancel of the old one) for one tower. */
export type PendingPlacement = {
  towerPub: string
  job: Event
  cancel: Event | null
}

/**
 * Journal for the success rule (§4.3): fully signed stage-5 events are
 * persisted before sending — a retry repeats only stage 5, without a new
 * NIP-07 cycle. One entry per message, each with a job per tower.
 */
export type PendingItem = {
  messageId: string
  recipient: string
  placements: PendingPlacement[]
  wrap: Event
  wrapEphemeralKey: string
  draftWrap: Event
}

export type PendingStage5 = {
  checkinAt: number
  publishAt: number
  /** Effective interval for this renewal, so a retry restores it consistently. */
  interval: number
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
