import { SimplePool } from 'nostr-tools/pool'
import * as nip19 from 'nostr-tools/nip19'
import {
  KIND_FEEDBACK,
  buildCancel,
  buildExport,
  buildJobRequest,
  buildWrapRevocation,
  computeSchedule,
  createCapsule,
  createCheckin,
  createDraftWrap,
  readDraftWrap,
  wrapRumor,
  type Event,
  type LastpubDraft,
  type LastpubExportV1,
  type Rumor,
  type Signer,
} from '@lastpub/core'
import {
  storage,
  type MessageData,
  type PendingItem,
  type PendingStage5,
  type Settings,
  type SwitchData,
} from './storage.js'

/**
 * Client flows of the web app (spec §4). No plaintext leaves the browser.
 * Switch (time model, check-in) and message (recipient, draft, capsule, job)
 * are kept separate; the switch owns the trigger.
 */

export class FeedbackError extends Error {
  constructor(readonly info: string) {
    super(`tower feedback: ${info}`)
  }
}

export class LastpubClient {
  readonly pool = new SimplePool()

  constructor(
    readonly signer: Signer,
    readonly settings: Settings,
  ) {}

  get towerPub(): string {
    const decoded = nip19.decode(this.settings.towerNpub)
    if (decoded.type !== 'npub') throw new Error('Invalid tower npub')
    return decoded.data
  }

  /** Tower of an existing switch: fixed at creation, settings only a fallback. */
  private towerFor(current?: { towerPub?: string }): string {
    return current?.towerPub || this.towerPub
  }

  /**
   * Exactly one message per switch. The storage shape is already 1:n, but the
   * transport is not: a tower keys scheduled jobs solely by author (§3.2 rule
   * 4) and deletes older ones on insert. A second job would silently replace
   * the first and still confirm 'scheduled' — the success rule would then
   * report success for a message that is no longer scheduled. Hence a hard
   * abort instead of losing data quietly.
   */
  private assertSingleMessage(current: SwitchData): void {
    if (current.messages.length > 1) {
      throw new Error(
        `This switch carries ${current.messages.length} messages. A tower schedules ` +
          'only one message per npub (§3.2 rule 4) — any further one would silently ' +
          'displace the previous one.',
      )
    }
  }

  private async publish(e: Event): Promise<void> {
    const results = await Promise.allSettled(this.pool.publish(this.settings.relays, e))
    if (!results.some((r) => r.status === 'fulfilled')) {
      throw new Error('no relay accepted the event')
    }
  }

  /**
   * Waits for the tower's 7000 feedback on a request. `expectInfo` filters
   * for the expected success status (e.g. 'cancelled'), so an older feedback
   * for the same request ID doesn't match incorrectly.
   */
  private awaitFeedback(
    tower: string,
    requestId: string,
    expectInfo: string,
    timeoutMs = 20_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.close()
        reject(new Error('Timeout: no tower confirmation'))
      }, timeoutMs)
      const sub = this.pool.subscribeMany(
        this.settings.relays,
        { kinds: [KIND_FEEDBACK], '#e': [requestId], authors: [tower] },
        {
          onevent: async (e) => {
            try {
              const tags = JSON.parse(
                await this.signer.nip44Decrypt(tower, e.content),
              ) as string[][]
              const status = tags.find((t) => t[0] === 'status')
              if (!status) return
              if (status[1] === 'success' && status[2] !== expectInfo) return
              clearTimeout(timer)
              sub.close()
              if (status[1] === 'success') resolve(status[2])
              else reject(new FeedbackError(status[2] ?? 'error'))
            } catch {
              // feedback for foreign requests / not decryptable — ignore
            }
          },
        },
      )
    })
  }

  /** Build capsule + job for a message (stage 4 + stage-5 preparation). */
  private async buildMessageArtifacts(args: {
    tower: string
    message: string
    recipient: string
    round: number
    publishAt: number
    messageId: string
    draftWrap: Event
    cancelRequestId?: string
  }): Promise<PendingItem & { publishAt: number }> {
    const { wrap, wrapEphemeralKey } = await createCapsule(this.signer, {
      plaintext: args.message,
      recipient: args.recipient,
      round: args.round,
    })
    const job = await buildJobRequest(this.signer, {
      wrap,
      publishAt: args.publishAt,
      relays: this.settings.relays,
      tower: args.tower,
    })
    return {
      messageId: args.messageId,
      recipient: args.recipient,
      cancel: args.cancelRequestId
        ? await buildCancel(this.signer, args.cancelRequestId, args.tower)
        : null,
      job,
      wrap,
      wrapEphemeralKey,
      draftWrap: args.draftWrap,
      publishAt: args.publishAt,
    }
  }

  /** Create flow (§4.2): switch + first message. */
  async createSwitch(args: {
    message: string
    recipientNpub: string
    interval: number
    grace: number
  }): Promise<SwitchData> {
    const decoded = nip19.decode(args.recipientNpub)
    if (decoded.type !== 'npub') throw new Error('Invalid recipient npub')
    const recipient = decoded.data

    const now = Math.floor(Date.now() / 1000)
    const switchId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const schedule = computeSchedule(now, args.interval, args.grace)

    const draftWrap = await createDraftWrap(this.signer, {
      switch_id: switchId,
      message: args.message,
      recipient,
      interval: args.interval,
      grace: args.grace,
      updated_at: now,
    })
    await this.publish(draftWrap).catch(() => {}) // relays are a secondary copy, best effort

    const tower = this.towerPub
    const artifacts = await this.buildMessageArtifacts({
      tower,
      message: args.message,
      recipient,
      round: schedule.round,
      publishAt: schedule.publishAt,
      messageId,
      draftWrap,
    })
    await this.publish(artifacts.job)
    await this.awaitFeedback(tower, artifacts.job.id, 'scheduled')

    const data: SwitchData = {
      switchId,
      towerPub: tower,
      interval: args.interval,
      grace: args.grace,
      lastCheckinAt: now,
      publishAt: schedule.publishAt,
      roundTime: schedule.roundTime,
      messages: [
        {
          id: messageId,
          recipient,
          requestId: artifacts.job.id,
          wrap: artifacts.wrap,
          wrapEphemeralKey: artifacts.wrapEphemeralKey,
          draftWrap,
          concealmentBroken: false,
        },
      ],
    }
    storage.saveSwitch(data)
    return data
  }

  /**
   * Check-in flow, 5 stages (§4.3): one 1042, then ALL messages are renewed
   * (new round, new capsule, new job). `edited` replaces the text of exactly
   * one message beforehand. Within the grace window, this is the revocation
   * (§4.4).
   */
  async checkin(
    current: SwitchData,
    edited?: { messageId: string; message: string },
  ): Promise<SwitchData> {
    this.assertSingleMessage(current)

    // Stage 1: sign 1042 and deliver it as a gift wrap to the tower npub
    const tower = this.towerFor(current)
    const checkinEvent = await createCheckin(this.signer, { switchId: current.switchId })
    const wrappedCheckin = await wrapRumor(
      this.signer,
      checkinEvent as unknown as Rumor,
      tower,
    )
    await this.publish(wrappedCheckin)

    // Stage 3: new shared trigger for all messages
    const schedule = computeSchedule(checkinEvent.created_at, current.interval, current.grace)

    // Stages 2 + 4 per message: read draft (edit if needed), rebuild capsule
    const items: PendingItem[] = []
    for (const msg of current.messages) {
      let draftWrap = msg.draftWrap
      let draft = await readDraftWrap(this.signer, draftWrap)
      if (edited && edited.messageId === msg.id && edited.message !== draft.message) {
        draftWrap = await createDraftWrap(this.signer, {
          switch_id: current.switchId,
          message: edited.message,
          recipient: msg.recipient,
          interval: current.interval,
          grace: current.grace,
          updated_at: checkinEvent.created_at,
        })
        await this.publish(draftWrap).catch(() => {})
        draft = await readDraftWrap(this.signer, draftWrap)
      }
      const artifacts = await this.buildMessageArtifacts({
        tower,
        message: draft.message,
        recipient: msg.recipient,
        round: schedule.round,
        publishAt: schedule.publishAt,
        messageId: msg.id,
        draftWrap,
        cancelRequestId: msg.requestId,
      })
      items.push(artifacts)
    }

    // Stage 5: signed events into the journal, then send (success rule §4.3)
    const pending: PendingStage5 = {
      checkinAt: checkinEvent.created_at,
      publishAt: schedule.publishAt,
      roundTime: schedule.roundTime,
      items,
    }
    storage.savePending(pending)
    return this.completeStage5(current, pending)
  }

  /**
   * Execute stage 5 (again) — also used for the journal retry after partial
   * success. Only successful once the job of EVERY message is confirmed.
   */
  async completeStage5(current: SwitchData, pending: PendingStage5): Promise<SwitchData> {
    this.assertSingleMessage(current)
    const tower = this.towerFor(current)
    for (const item of pending.items) {
      if (item.cancel) await this.publish(item.cancel)
      await this.publish(item.job)
    }
    await Promise.all(
      pending.items.map((item) => this.awaitFeedback(tower, item.job.id, 'scheduled')),
    )

    // Revocation (§4.4): delete published (burned) capsules via NIP-09 —
    // signed with the retained ephemeral key, best effort
    const wasTriggered = Math.floor(Date.now() / 1000) > current.publishAt
    if (wasTriggered) {
      for (const msg of current.messages) {
        if (!msg.wrapEphemeralKey) continue
        const revocation = buildWrapRevocation(msg.wrapEphemeralKey, msg.wrap.id)
        await this.publish(revocation).catch(() => {})
      }
    }

    const messages: MessageData[] = current.messages.map((msg) => {
      const item = pending.items.find((i) => i.messageId === msg.id)
      if (!item) return msg
      return {
        ...msg,
        requestId: item.job.id,
        wrap: item.wrap,
        wrapEphemeralKey: item.wrapEphemeralKey,
        draftWrap: item.draftWrap,
        concealmentBroken: msg.concealmentBroken || wasTriggered,
      }
    })
    const data: SwitchData = {
      ...current,
      lastCheckinAt: pending.checkinAt,
      publishAt: pending.publishAt,
      roundTime: pending.roundTime,
      messages,
    }
    storage.saveSwitch(data)
    storage.clearPending()
    return data
  }

  /** Delete before trigger (§4.4): silent, hard cancellation of all message jobs. */
  async deleteSwitch(current: SwitchData): Promise<void> {
    const tower = this.towerFor(current)
    for (const msg of current.messages) {
      const cancel = await buildCancel(this.signer, msg.requestId, tower)
      await this.publish(cancel)
      await this.awaitFeedback(tower, msg.requestId, 'cancelled')
    }
    storage.clearSwitch()
    storage.clearPending()
  }

  /** Decrypt a message's draft (e.g. to prefill the edit field). */
  async readDraft(current: SwitchData, messageId?: string): Promise<LastpubDraft> {
    const msg = this.messageOf(current, messageId)
    return readDraftWrap(this.signer, msg.draftWrap)
  }

  /** Ciphertext export (§4.5) for a message. */
  buildExportFile(current: SwitchData, messageId?: string): LastpubExportV1 {
    const msg = this.messageOf(current, messageId)
    return buildExport({
      wrap: msg.wrap,
      jobRequestId: msg.requestId,
      tower: this.towerFor(current),
      publishAt: current.publishAt,
      relays: this.settings.relays,
      draftWrap: msg.draftWrap,
    })
  }

  private messageOf(current: SwitchData, messageId?: string): MessageData {
    const msg = messageId
      ? current.messages.find((m) => m.id === messageId)
      : current.messages[0]
    if (!msg) throw new Error('Message not found')
    return msg
  }

  close(): void {
    this.pool.close(this.settings.relays)
  }
}
