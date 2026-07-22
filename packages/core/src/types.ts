import type { Event, EventTemplate, VerifiedEvent } from 'nostr-tools'

export type { Event, EventTemplate, VerifiedEvent }

/** Unsigned event with id + pubkey, without sig (NIP-59 rumor). */
export type Rumor = Omit<Event, 'sig'>

/** Draft payload in the self-gift-wrap (spec §1.5). */
export type LastpubDraft = {
  v: 1
  type: 'lastpub-draft'
  switch_id: string
  message: string
  recipient: string
  interval: number
  updated_at: number
}

/** Ciphertext export (spec §4.5). */
export type LastpubExportV1 = {
  v: 1
  type: 'lastpub-export'
  exported_at: number
  capsule: { wrap: Event; nevent: string }
  job: { request_id: string; tower: string; publish_at: number }
  draft_wrap?: Event
  drand: { chain: string; genesis: number; period: number }
}

export type Schedule = {
  deadline: number
  publishAt: number
  round: number
}

export type CheckinVerdict =
  | { ok: true }
  | { ok: false; reason: 'sig' | 'kind' | 'monotonic' | 'tolerance' | 'replay' }

export type WrapVerdict = { ok: true } | { ok: false; reason: string }
