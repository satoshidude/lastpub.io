import {
  KIND_CHECKIN,
  KIND_DELETE,
  KIND_FEEDBACK,
  KIND_JOB,
  KIND_JOB_RESULT,
  KIND_WRAP,
  LastpubError,
  decryptJobRequest,
  unwrapToRumor,
  verifyCheckin,
  type Event,
  type Signer,
  type VerifiedEvent,
} from '@lastpub/core'
import { TowerDb, type JobRow } from './db.js'
import type { Transport } from './transport.js'

export type TowerOptions = {
  signer: Signer
  db: TowerDb
  transport: Transport
  fallbackRelays: string[]
  now?: () => number
  /** Backoff between broadcast retries (seconds). */
  retryDelaySec?: number
}

/**
 * Reference tower (design doc §3): only messenger + alarm clock. Accepts
 * 5905 jobs, withholds wraps, never resets anything on its own — the
 * timer reset only ever materializes through a new job (§3.3).
 */
export class Tower {
  private readonly now: () => number
  private readonly retryDelaySec: number

  constructor(private readonly opts: TowerOptions) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.retryDelaySec = opts.retryDelaySec ?? 30
  }

  /**
   * Dispatch for events addressed to the tower npub.
   * Returns: response events (7000/6900) for the caller to publish.
   */
  async handleEvent(e: Event): Promise<VerifiedEvent[]> {
    switch (e.kind) {
      case KIND_JOB:
        return this.handleJobRequest(e)
      case KIND_DELETE:
        return this.handleCancel(e)
      case KIND_WRAP:
        return this.handleCheckinWrap(e)
      default:
        return []
    }
  }

  /** Job acceptance (§3.2): commit first, then confirm (stage-5 commitment). */
  private async handleJobRequest(e: Event): Promise<VerifiedEvent[]> {
    const now = this.now()

    // Idempotency: an identical request is reconfirmed, not duplicated
    const existing = this.opts.db.getJobByRequestId(e.id)
    if (existing) {
      return [await this.feedback(e.pubkey, e.id, 'success', 'scheduled')]
    }

    let job
    try {
      job = await decryptJobRequest(this.opts.signer, e)
    } catch (err) {
      const reason = err instanceof LastpubError ? err.message : 'invalid request'
      return [await this.feedback(e.pubkey, e.id, 'error', `invalid-request: ${reason}`)]
    }
    if (job.publishAt <= now) {
      return [await this.feedback(e.pubkey, e.id, 'error', 'publish-at-past')]
    }
    this.opts.db.insertJob({
      requestId: job.requestId,
      author: job.author,
      wrap: job.wrap,
      publishAt: job.publishAt,
      relays: job.relays,
      now,
    })
    return [await this.feedback(job.author, job.requestId, 'success', 'scheduled')]
  }

  /** Cancellation (§3.5): kind 5 from the job author, hard delete, silent toward the recipient. */
  private async handleCancel(e: Event): Promise<VerifiedEvent[]> {
    const responses: VerifiedEvent[] = []
    for (const tag of e.tags) {
      if (tag[0] !== 'e' || !tag[1]) continue
      if (this.opts.db.deleteScheduledJob(tag[1], e.pubkey)) {
        responses.push(await this.feedback(e.pubkey, tag[1], 'success', 'cancelled'))
      }
    }
    return responses
  }

  /**
   * 1042 processing (§3.3): unwrap the gift wrap addressed to the tower npub,
   * verify the inner signed 1042 with replay protection, only set the
   * monotonicity anchor. No timer reset — that only ever comes via a new job.
   */
  private async handleCheckinWrap(wrap: Event): Promise<VerifiedEvent[]> {
    const now = this.now()
    let inner: Event
    try {
      const { rumor } = await unwrapToRumor(this.opts.signer, wrap)
      inner = rumor as Event
    } catch {
      return [] // not a wrap addressed to us / not valid — ignore silently
    }
    if (inner.kind !== KIND_CHECKIN) return []

    const verdict = verifyCheckin(inner, {
      lastCreatedAt: this.opts.db.lastCheckinAt(inner.pubkey),
      seenIds: { has: (id: string) => this.opts.db.hasSeenEvent(id) },
      now,
    })
    if (!verdict.ok) return []

    // Switch ownership: only authors with a stored job (§3.3)
    if (!this.opts.db.hasAnyJob(inner.pubkey)) return []

    this.opts.db.recordCheckin(inner.pubkey, inner.created_at, inner.id, now)
    return []
  }

  /**
   * Trigger loop tick (§3.4): broadcast due jobs. At-least-once —
   * publishing jobs are retried after a crash/partial success; a
   * duplicate broadcast of the same 1059 is idempotent (same event ID).
   */
  async tick(): Promise<VerifiedEvent[]> {
    const now = this.now()
    this.opts.db.pruneSeenEvents(now)
    const responses: VerifiedEvent[] = []

    for (const job of this.opts.db.dueJobs(now, this.retryDelaySec)) {
      this.opts.db.markPublishing(job.id, now)
      const wrap = JSON.parse(job.wrap_json) as Event
      const recipient = wrap.tags.find((t) => t[0] === 'p')?.[1] ?? ''

      const dmRelays = await this.opts.transport.fetchDmRelays(recipient)
      const jobRelays = JSON.parse(job.relays_json) as string[]
      const targets = [...new Set([...dmRelays, ...jobRelays, ...this.opts.fallbackRelays])]

      const okCount = await this.opts.transport.publish(wrap, targets)
      if (okCount < Math.min(2, targets.length)) {
        continue // stays publishing → retry after backoff
      }

      this.opts.db.markPublished(job.id, wrap.id, now)
      responses.push(await this.result(job, wrap.id))
    }
    return responses
  }

  /** Feedback kind 7000 (§1.4), NIP-44-encrypted to the author. */
  private async feedback(
    author: string,
    requestId: string,
    status: 'success' | 'error',
    info: string,
  ): Promise<VerifiedEvent> {
    return this.opts.signer.signEvent({
      kind: KIND_FEEDBACK,
      created_at: this.now(),
      content: await this.opts.signer.nip44Encrypt(
        author,
        JSON.stringify([['status', status, info]]),
      ),
      tags: [
        ['e', requestId],
        ['p', author],
        ['encrypted'],
      ],
    })
  }

  /** Result kind 6900 (§1.4): event ID of the published wrap, encrypted. */
  private async result(job: JobRow, publishedId: string): Promise<VerifiedEvent> {
    return this.opts.signer.signEvent({
      kind: KIND_JOB_RESULT,
      created_at: this.now(),
      content: await this.opts.signer.nip44Encrypt(job.author, publishedId),
      tags: [
        ['e', job.request_id],
        ['p', job.author],
        ['encrypted'],
      ],
    })
  }
}
