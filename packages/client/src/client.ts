import { SimplePool } from 'nostr-tools/pool'
import * as nip19 from 'nostr-tools/nip19'
import {
  KIND_FEEDBACK,
  KIND_JOB,
  KIND_WRAP,
  buildCancel,
  buildExport,
  buildJobRequest,
  computeSchedule,
  createCapsule,
  createCheckin,
  createDraftWrap,
  readDraftWrap,
  verifyCapsuleWrap,
  wrapRumor,
  type Event,
  type LastpubDraft,
  type LastpubExportV1,
  type Rumor,
  type Signer,
} from '@lastpub/core'
import type {
  ClientOptions,
  MessageData,
  PendingItem,
  PendingStage5,
  Settings,
  StorageAdapter,
  SwitchData,
} from './types.js'

/**
 * lastpub client flows (spec §4). No plaintext leaves the process. Switch
 * (time model, check-in) and message (recipient, draft, capsule, job) are kept
 * separate; the switch owns the trigger. Framework-agnostic: crypto comes from
 * a Signer, persistence from a StorageAdapter.
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
    private readonly storage: StorageAdapter,
    private readonly options: ClientOptions = {},
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
   * Product policy for the minimal client: one message per switch. The
   * transport supports more — the tower keys jobs by (author, slot) and each
   * message carries its own slot (§3.2) — so a richer client sets
   * `allowMultipleMessages`. When it is off, refuse a multi-message switch
   * rather than surprise the user with a scope the UI does not cover.
   */
  private assertSingleMessage(current: SwitchData): void {
    if (this.options.allowMultipleMessages) return
    if (current.messages.length > 1) {
      throw new Error(
        `This switch carries ${current.messages.length} messages, but this client is ` +
          'configured for a single message per switch (set allowMultipleMessages to change).',
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
      // Each message is its own slot on the tower, so several messages per
      // switch coexist instead of overwriting one another (§3.2).
      slot: args.messageId,
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
  }): Promise<SwitchData> {
    const decoded = nip19.decode(args.recipientNpub)
    if (decoded.type !== 'npub') throw new Error('Invalid recipient npub')
    const recipient = decoded.data

    const now = Math.floor(Date.now() / 1000)
    const switchId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const schedule = computeSchedule(now, args.interval)

    const draftWrap = await createDraftWrap(this.signer, {
      switch_id: switchId,
      message: args.message,
      recipient,
      interval: args.interval,
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
      lastCheckinAt: now,
      publishAt: schedule.publishAt,
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
    this.storage.saveSwitch(data)
    return data
  }

  /**
   * Check-in flow, 5 stages (§4.3): one 1042, then ALL messages are renewed
   * (new round, new capsule, new job). `edited` replaces the text of exactly
   * one message beforehand; `timing` changes the interval from now on.
   */
  async checkin(
    current: SwitchData,
    edited?: { messageId: string; message: string },
    timing?: { interval: number },
  ): Promise<SwitchData> {
    this.assertSingleMessage(current)

    // A check-in may also change the timer: the new interval takes effect from
    // this check-in (a reschedule), so the whole switch is rebuilt against it.
    const interval = timing?.interval ?? current.interval

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
    const schedule = computeSchedule(checkinEvent.created_at, interval)

    // Stages 2 + 4 per message: read draft (edit if needed), rebuild capsule
    const items: PendingItem[] = []
    for (const msg of current.messages) {
      let draftWrap = msg.draftWrap
      let draft = await readDraftWrap(this.signer, draftWrap)
      const intervalChanged = interval !== current.interval
      if (
        (edited && edited.messageId === msg.id && edited.message !== draft.message) ||
        intervalChanged
      ) {
        draftWrap = await createDraftWrap(this.signer, {
          switch_id: current.switchId,
          message:
            edited && edited.messageId === msg.id ? edited.message : draft.message,
          recipient: msg.recipient,
          interval,
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
      interval,
      items,
    }
    this.storage.savePending(pending)
    return this.completeStage5({ ...current, interval }, pending)
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

    // If the deadline had already passed, the old capsule was published and is
    // readable — there is no revocation, only the honest record that
    // concealment toward that recipient is now broken.
    const wasPublished = Math.floor(Date.now() / 1000) > current.publishAt

    const messages: MessageData[] = current.messages.map((msg) => {
      const item = pending.items.find((i) => i.messageId === msg.id)
      if (!item) return msg
      return {
        ...msg,
        requestId: item.job.id,
        wrap: item.wrap,
        wrapEphemeralKey: item.wrapEphemeralKey,
        draftWrap: item.draftWrap,
        concealmentBroken: msg.concealmentBroken || wasPublished,
      }
    })
    const data: SwitchData = {
      ...current,
      interval: pending.interval,
      lastCheckinAt: pending.checkinAt,
      publishAt: pending.publishAt,
      messages,
    }
    this.storage.saveSwitch(data)
    this.storage.clearPending()
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
    this.storage.clearSwitch()
    this.storage.clearPending()
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

  /**
   * Rebuild switch state from an export file (§4.5), so an active switch can be
   * resumed on a fresh install or device. The export carries the capsule, the
   * job binding (tower + request id) and the draft — enough to reconstruct the
   * full state and continue: a check-in cancels the old job by its request id
   * and schedules a fresh one, even against a different tower.
   */
  async restoreFromExport(exp: LastpubExportV1): Promise<SwitchData> {
    if (exp?.type !== 'lastpub-export' || exp.v !== 1) {
      throw new Error('Not a lastpub export file')
    }
    if (!exp.draft_wrap) {
      throw new Error('This export has no draft, so the switch cannot be resumed from it')
    }
    const draft = await readDraftWrap(this.signer, exp.draft_wrap)
    const publishAt = exp.job.publish_at
    const data: SwitchData = {
      switchId: draft.switch_id,
      towerPub: exp.job.tower,
      interval: draft.interval,
      lastCheckinAt: publishAt - draft.interval,
      publishAt,
      messages: [
        {
          id: crypto.randomUUID(),
          recipient: draft.recipient,
          requestId: exp.job.request_id,
          wrap: exp.capsule.wrap,
          wrapEphemeralKey: '',
          draftWrap: exp.draft_wrap,
          concealmentBroken: Math.floor(Date.now() / 1000) > publishAt,
        },
      ],
    }
    this.storage.saveSwitch(data)
    return data
  }

  /**
   * Rebuild switch state from the author's own events on the relays — the
   * recovery path when there is no export and localStorage is gone. The draft
   * (self-gift-wrapped kind 14) and the 5905 job are both published to relays;
   * the job's payload is encrypted to the tower, but the author shares that
   * NIP-44 conversation key and can read it back. Reconstructs the single
   * current switch from the newest draft and the newest job. Returns null if no
   * draft is found; throws if a draft exists but its job is not on these relays.
   */
  async restoreFromRelay(): Promise<SwitchData | null> {
    const me = await this.signer.getPublicKey()

    // Newest lastpub-draft among the self-addressed gift wraps.
    const wraps = await this.pool.querySync(this.settings.relays, {
      kinds: [KIND_WRAP],
      '#p': [me],
    })
    let bestDraft: { draft: LastpubDraft; wrap: Event } | null = null
    for (const w of wraps) {
      try {
        const d = await readDraftWrap(this.signer, w)
        if (!bestDraft || d.updated_at > bestDraft.draft.updated_at) bestDraft = { draft: d, wrap: w }
      } catch {
        // not one of our drafts
      }
    }
    if (!bestDraft) return null

    // Newest 5905 job authored by us → tower (p tag), request id, and the
    // encrypted payload (wrap + publish_at) which we decrypt with the tower key.
    const jobs = await this.pool.querySync(this.settings.relays, {
      kinds: [KIND_JOB],
      authors: [me],
    })
    let bestJob: {
      tower: string
      requestId: string
      wrap: Event
      publishAt: number
      createdAt: number
    } | null = null
    for (const j of jobs) {
      const tower = j.tags.find((t) => t[0] === 'p')?.[1]
      if (!tower) continue
      try {
        const tags = JSON.parse(await this.signer.nip44Decrypt(tower, j.content)) as string[][]
        const iTag = tags.find((t) => t[0] === 'i')
        const paTag = tags.find((t) => t[0] === 'param' && t[1] === 'publish_at')
        if (!iTag || !paTag) continue
        const wrap = JSON.parse(iTag[1]) as Event
        if (!verifyCapsuleWrap(wrap).ok) continue
        if (!bestJob || j.created_at > bestJob.createdAt) {
          bestJob = {
            tower,
            requestId: j.id,
            wrap,
            publishAt: Number(paTag[2]),
            createdAt: j.created_at,
          }
        }
      } catch {
        // not decryptable by us / not a job to a tower we can read
      }
    }
    if (!bestJob) {
      throw new Error(
        'Recovered your message draft, but the scheduled job is not on these relays. ' +
          'Import your export file instead, or add the relay you originally used.',
      )
    }

    const data: SwitchData = {
      switchId: bestDraft.draft.switch_id,
      towerPub: bestJob.tower,
      interval: bestDraft.draft.interval,
      lastCheckinAt: bestJob.publishAt - bestDraft.draft.interval,
      publishAt: bestJob.publishAt,
      messages: [
        {
          id: crypto.randomUUID(),
          recipient: bestDraft.draft.recipient,
          requestId: bestJob.requestId,
          wrap: bestJob.wrap,
          wrapEphemeralKey: '',
          draftWrap: bestDraft.wrap,
          concealmentBroken: Math.floor(Date.now() / 1000) > bestJob.publishAt,
        },
      ],
    }
    this.storage.saveSwitch(data)
    return data
  }

  close(): void {
    this.pool.close(this.settings.relays)
  }
}
