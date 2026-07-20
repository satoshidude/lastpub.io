import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  LocalSigner,
  buildCancel,
  buildJobRequest,
  createCheckin,
  wrapRumor,
  type Event,
  type Rumor,
  type VerifiedEvent,
} from '@lastpub/core'
import { Tower } from '../src/tower.js'
import { TowerDb } from '../src/db.js'
import type { Transport } from '../src/transport.js'

/** Deterministic fake capsule: a structurally valid 1059 is enough for the tower. */
async function fakeWrap(author: LocalSigner, recipient: string): Promise<VerifiedEvent> {
  const rumor: Rumor = {
    id: '',
    pubkey: await author.getPublicKey(),
    created_at: 1_800_000_000,
    kind: 1041,
    content: 'ZmFrZQ==',
    tags: [['tlock', 'a'.repeat(64), '1']],
  }
  return wrapRumor(author, rumor, recipient)
}

class FakeTransport implements Transport {
  published: { event: Event; relays: string[] }[] = []
  dmRelays: Record<string, string[]> = {}
  okOverride: number | null = null

  async publish(event: Event, relays: string[]): Promise<number> {
    this.published.push({ event, relays })
    return this.okOverride ?? relays.length
  }

  async fetchDmRelays(pubkey: string): Promise<string[]> {
    return this.dmRelays[pubkey] ?? []
  }
}

const FALLBACK = ['wss://fb1.example', 'wss://fb2.example']

describe('Tower', () => {
  let db: TowerDb
  let transport: FakeTransport
  let towerSigner: LocalSigner
  let towerPub: string
  let author: LocalSigner
  let authorPub: string
  let recipientPub: string
  let now: number
  let tower: Tower

  beforeEach(async () => {
    db = new TowerDb(':memory:')
    transport = new FakeTransport()
    towerSigner = new LocalSigner(generateSecretKey())
    towerPub = await towerSigner.getPublicKey()
    const authorSk = generateSecretKey()
    author = new LocalSigner(authorSk)
    authorPub = getPublicKey(authorSk)
    recipientPub = getPublicKey(generateSecretKey())
    now = 1_800_000_000
    tower = new Tower({
      signer: towerSigner,
      db,
      transport,
      fallbackRelays: FALLBACK,
      now: () => now,
      retryDelaySec: 30,
    })
  })

  async function submitJob(
    publishAtOffset = 3600,
    slot?: string,
  ): Promise<{ job: VerifiedEvent; wrap: VerifiedEvent }> {
    const wrap = await fakeWrap(author, recipientPub)
    const job = await buildJobRequest(author, {
      wrap,
      publishAt: now + publishAtOffset,
      relays: ['wss://client.example'],
      tower: towerPub,
      slot,
    })
    return { job, wrap }
  }

  async function decryptFeedback(e: Event): Promise<string[][]> {
    return JSON.parse(await author.nip44Decrypt(towerPub, e.content))
  }

  describe('Job acceptance (§3.2)', () => {
    it('valid job: persisted, 7000 success/scheduled', async () => {
      const { job } = await submitJob()
      const [fb] = await tower.handleEvent(job)
      expect(fb.kind).toBe(7000)
      expect(fb.tags).toContainEqual(['e', job.id])
      expect(fb.tags).toContainEqual(['p', authorPub])
      expect(await decryptFeedback(fb)).toEqual([['status', 'success', 'scheduled']])
      expect(db.getJobByRequestId(job.id)?.status).toBe('scheduled')
    })

    it('idempotent: same request again → success, no duplicate', async () => {
      const { job } = await submitJob()
      await tower.handleEvent(job)
      const [fb] = await tower.handleEvent(job)
      expect(await decryptFeedback(fb)).toEqual([['status', 'success', 'scheduled']])
      expect(db.hasAnyJob(authorPub)).toBe(true)
    })

    it('same slot: new job replaces the old scheduled job (renewal)', async () => {
      const a = await submitJob(3600)
      const b = await submitJob(7200)
      await tower.handleEvent(a.job)
      await tower.handleEvent(b.job)
      expect(db.getJobByRequestId(a.job.id)).toBeUndefined()
      expect(db.getJobByRequestId(b.job.id)?.publish_at).toBe(now + 7200)
    })

    it('distinct slots coexist: several messages per author', async () => {
      const a = await submitJob(3600, 'msg-a')
      const b = await submitJob(7200, 'msg-b')
      await tower.handleEvent(a.job)
      await tower.handleEvent(b.job)
      // Neither displaces the other — two withheld jobs for one author.
      expect(db.getJobByRequestId(a.job.id)?.publish_at).toBe(now + 3600)
      expect(db.getJobByRequestId(b.job.id)?.publish_at).toBe(now + 7200)
      // Renewing slot msg-a replaces only its own job, leaves msg-b untouched.
      const a2 = await submitJob(9000, 'msg-a')
      await tower.handleEvent(a2.job)
      expect(db.getJobByRequestId(a.job.id)).toBeUndefined()
      expect(db.getJobByRequestId(a2.job.id)?.publish_at).toBe(now + 9000)
      expect(db.getJobByRequestId(b.job.id)?.publish_at).toBe(now + 7200)
    })

    it('records the slot on the job row', async () => {
      const { job } = await submitJob(3600, 'slot-x')
      await tower.handleEvent(job)
      expect(db.getJobByRequestId(job.id)?.slot).toBe('slot-x')
    })

    it('publish_at in the past → 7000 error', async () => {
      const { job } = await submitJob(-10)
      const [fb] = await tower.handleEvent(job)
      const [[, status, info]] = await decryptFeedback(fb)
      expect(status).toBe('error')
      expect(info).toBe('publish-at-past')
      expect(db.hasAnyJob(authorPub)).toBe(false)
    })

    it('undecryptable request → 7000 error invalid-request', async () => {
      const strangerTower = new LocalSigner(generateSecretKey())
      const wrap = await fakeWrap(author, recipientPub)
      const job = await buildJobRequest(author, {
        wrap,
        publishAt: now + 3600,
        relays: [],
        tower: await strangerTower.getPublicKey(), // encrypted to a foreign tower
      })
      const [fb] = await tower.handleEvent(job)
      const [[, status, info]] = await decryptFeedback(fb)
      expect(status).toBe('error')
      expect(info).toContain('invalid-request')
    })
  })

  describe('Check-in (§3.3)', () => {
    async function sendCheckin(at: number, signer = author): Promise<Event[]> {
      const checkin = await createCheckin(signer, { now: at })
      const wrapped = await wrapRumor(signer, checkin as unknown as Rumor, towerPub)
      return tower.handleEvent(wrapped)
    }

    it('valid 1042 sets the monotonicity anchor, no job reset', async () => {
      const { job } = await submitJob()
      await tower.handleEvent(job)
      const before = db.getJobByRequestId(job.id)!
      await sendCheckin(now)
      expect(db.lastCheckinAt(authorPub)).toBe(now)
      expect(db.getJobByRequestId(job.id)).toEqual(before) // job untouched
    })

    it('replay: older/equal created_at is ignored', async () => {
      const { job } = await submitJob()
      await tower.handleEvent(job)
      await sendCheckin(now)
      await sendCheckin(now) // equal → monotonic reject
      await sendCheckin(now - 60)
      expect(db.lastCheckinAt(authorPub)).toBe(now)
    })

    it('tolerance: created_at outside ±10 min is ignored', async () => {
      const { job } = await submitJob()
      await tower.handleEvent(job)
      await sendCheckin(now - 700)
      expect(db.lastCheckinAt(authorPub)).toBe(0)
    })

    it('unknown author without a job is ignored', async () => {
      const stranger = new LocalSigner(generateSecretKey())
      await sendCheckin(now, stranger)
      expect(db.lastCheckinAt(await stranger.getPublicKey())).toBe(0)
    })
  })

  describe('Cancellation (§3.5)', () => {
    it('kind 5 from the author hard-deletes the job, 7000 cancelled', async () => {
      const { job } = await submitJob()
      await tower.handleEvent(job)
      const cancel = await buildCancel(author, job.id, towerPub)
      const [fb] = await tower.handleEvent(cancel)
      expect(await decryptFeedback(fb)).toEqual([['status', 'success', 'cancelled']])
      expect(db.getJobByRequestId(job.id)).toBeUndefined()
    })

    it('foreign kind 5 is silently ignored', async () => {
      const { job } = await submitJob()
      await tower.handleEvent(job)
      const stranger = new LocalSigner(generateSecretKey())
      const cancel = await buildCancel(stranger, job.id, towerPub)
      const responses = await tower.handleEvent(cancel)
      expect(responses).toEqual([])
      expect(db.getJobByRequestId(job.id)?.status).toBe('scheduled')
    })
  })

  describe('Trigger (§3.4)', () => {
    it('due job: broadcast to 10050 ∪ job relays ∪ fallback, 6900 to author', async () => {
      transport.dmRelays[recipientPub] = ['wss://dm.example']
      const { job, wrap } = await submitJob(3600)
      await tower.handleEvent(job)

      now += 3601
      const responses = await tower.tick()

      const broadcast = transport.published.find((p) => p.event.kind === 1059)!
      expect(broadcast.event.id).toBe(wrap.id)
      expect(broadcast.relays).toEqual(
        expect.arrayContaining(['wss://dm.example', 'wss://client.example', ...FALLBACK]),
      )
      expect(db.getJobByRequestId(job.id)?.status).toBe('published')
      expect(db.getJobByRequestId(job.id)?.result_event_id).toBe(wrap.id)

      const result = responses.find((r) => r.kind === 6900)!
      expect(await author.nip44Decrypt(towerPub, result.content)).toBe(wrap.id)
    })

    it('partial success (< 2 OKs): stays publishing, retry after backoff succeeds', async () => {
      const { job, wrap } = await submitJob(3600)
      await tower.handleEvent(job)

      now += 3601
      transport.okOverride = 1
      await tower.tick()
      expect(db.getJobByRequestId(job.id)?.status).toBe('publishing')

      // Backoff not yet elapsed → no new attempt
      transport.okOverride = null
      now += 10
      await tower.tick()
      expect(db.getJobByRequestId(job.id)?.status).toBe('publishing')

      now += 30
      await tower.tick()
      expect(db.getJobByRequestId(job.id)?.status).toBe('published')
      expect(
        transport.published.filter((p) => p.event.id === wrap.id).length,
      ).toBeGreaterThanOrEqual(2)
    })

    it('crash recovery: publishing job is rebroadcast by a new instance', async () => {
      const { job, wrap } = await submitJob(3600)
      await tower.handleEvent(job)
      now += 3601
      transport.okOverride = 0
      await tower.tick()
      expect(db.getJobByRequestId(job.id)?.status).toBe('publishing')

      // "Restart": new tower instance on the same DB
      const transport2 = new FakeTransport()
      const tower2 = new Tower({
        signer: towerSigner,
        db,
        transport: transport2,
        fallbackRelays: FALLBACK,
        now: () => now + 60,
      })
      await tower2.tick()
      expect(db.getJobByRequestId(job.id)?.status).toBe('published')
      expect(transport2.published.some((p) => p.event.id === wrap.id)).toBe(true)
    })

    it('not-yet-due job stays untouched (withholding)', async () => {
      const { job } = await submitJob(3600)
      await tower.handleEvent(job)
      await tower.tick()
      expect(transport.published.filter((p) => p.event.kind === 1059)).toEqual([])
      expect(db.getJobByRequestId(job.id)?.status).toBe('scheduled')
    })
  })

  describe('Revocation scenario (§4.4, tower view)', () => {
    it('after trigger: check-in is still accepted, new job starts normally', async () => {
      const { job } = await submitJob(3600)
      await tower.handleEvent(job)
      now += 3601
      await tower.tick()
      expect(db.getJobByRequestId(job.id)?.status).toBe('published')

      // Grace window: 1042 + new job (full 5-stage flow)
      const checkin = await createCheckin(author, { now })
      const wrapped = await wrapRumor(author, checkin as unknown as Rumor, towerPub)
      await tower.handleEvent(wrapped)
      expect(db.lastCheckinAt(authorPub)).toBe(now)

      const fresh = await submitJob(3600)
      const [fb] = await tower.handleEvent(fresh.job)
      expect(await decryptFeedback(fb)).toEqual([['status', 'success', 'scheduled']])
      expect(db.getJobByRequestId(fresh.job.id)?.status).toBe('scheduled')
      // published (burned) job remains as history
      expect(db.getJobByRequestId(job.id)?.status).toBe('published')
    })
  })
})
