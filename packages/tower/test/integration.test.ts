import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import WebSocket from 'ws'
import {
  KIND_DM_RELAYS,
  LocalSigner,
  buildJobRequest,
  createCheckin,
  wrapRumor,
  type Event,
  type Rumor,
} from '@lastpub/core'
import { MiniRelay } from '../src/mini-relay.js'
import { startTower, type RunningTower } from '../src/run.js'

useWebSocketImplementation(WebSocket)

/**
 * Client↔tower over the real relay protocol (design doc §10 step 3):
 * full flow job → 7000 → trigger → 1059 broadcast → 6900,
 * hermetically against an in-process relay.
 */
describe('Integration: Client ↔ Tower over mini relay', () => {
  let relay: MiniRelay
  let running: RunningTower
  let pool: SimplePool
  let author: LocalSigner
  let authorPub: string
  let recipientSk: Uint8Array
  let recipientPub: string

  beforeAll(async () => {
    relay = await MiniRelay.start()
    const authorSk = generateSecretKey()
    author = new LocalSigner(authorSk)
    authorPub = getPublicKey(authorSk)
    recipientSk = generateSecretKey()
    recipientPub = getPublicKey(recipientSk)
    running = await startTower({
      signer: new LocalSigner(generateSecretKey()),
      relays: [relay.url],
      fallbackRelays: [relay.url],
      tickMs: 100,
    })
    pool = new SimplePool()
  })

  afterAll(async () => {
    pool.close([relay.url])
    await running.stop()
    await relay.close()
  })

  function awaitEvent(filter: Parameters<SimplePool['subscribeMany']>[1], timeoutMs = 8000): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.close()
        reject(new Error(`timeout waiting for ${JSON.stringify(filter)}`))
      }, timeoutMs)
      const sub = pool.subscribeMany([relay.url], filter, {
        onevent: (e) => {
          clearTimeout(timer)
          sub.close()
          resolve(e)
        },
      })
    })
  }

  async function fakeWrap(): Promise<Event> {
    const rumor: Rumor = {
      id: '',
      pubkey: authorPub,
      created_at: Math.floor(Date.now() / 1000),
      kind: 1041,
      content: 'ZmFrZQ==',
      tags: [['tlock', 'a'.repeat(64), '1']],
    }
    return wrapRumor(author, rumor, recipientPub)
  }

  it('full lifecycle: job → 7000 → check-in → trigger → 1059 + 6900', async () => {
    const now = Math.floor(Date.now() / 1000)

    // Recipient publishes its kind-10050 DM relay list
    const recipient = new LocalSigner(recipientSk)
    const dmRelayList = await recipient.signEvent({
      kind: KIND_DM_RELAYS,
      created_at: now,
      content: '',
      tags: [['relay', relay.url]],
    })
    await Promise.allSettled(pool.publish([relay.url], dmRelayList))

    // Stage 5: submit job, wait for 7000 success/scheduled
    const wrap = await fakeWrap()
    const job = await buildJobRequest(author, {
      wrap,
      publishAt: now + 2,
      relays: [relay.url],
      tower: running.towerPub,
    })
    const feedbackPromise = awaitEvent({ kinds: [7000], '#e': [job.id] })
    await Promise.allSettled(pool.publish([relay.url], job))
    const feedback = await feedbackPromise
    const status = JSON.parse(await author.nip44Decrypt(running.towerPub, feedback.content))
    expect(status).toEqual([['status', 'success', 'scheduled']])

    // Stage 1: check-in as gift wrap to the tower npub
    const checkin = await createCheckin(author)
    const wrappedCheckin = await wrapRumor(author, checkin as unknown as Rumor, running.towerPub)
    await Promise.allSettled(pool.publish([relay.url], wrappedCheckin))

    // Trigger: publish_at elapses → tower broadcasts the withheld 1059
    const published = await awaitEvent({ kinds: [1059], ids: [wrap.id] })
    expect(published.id).toBe(wrap.id)
    expect(published.tags).toContainEqual(['p', recipientPub])

    // Result 6900 with the event ID of the published wrap
    const result = await awaitEvent({ kinds: [6900], '#e': [job.id] })
    expect(await author.nip44Decrypt(running.towerPub, result.content)).toBe(wrap.id)

    // DB view: published, monotonicity anchor set
    expect(running.db.getJobByRequestId(job.id)?.status).toBe('published')
    expect(running.db.lastCheckinAt(authorPub)).toBe(checkin.created_at)
  }, 20_000)
})
