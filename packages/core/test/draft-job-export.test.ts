import { describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { createDraftWrap, readDraftWrap } from '../src/draft.js'
import { buildJobRequest, decryptJobRequest, buildCancel } from '../src/job.js'
import { buildExport } from '../src/export.js'
import { createCapsule } from '../src/capsule.js'
import { roundForTime } from '../src/schedule.js'
import { FakeTlockEngine, newSigner } from './helpers.js'

const now = 1_800_000_000
const tlock = new FakeTlockEngine()

describe('Draft (Self-Gift-Wrap, §1.5)', () => {
  it('Round-Trip: createDraftWrap → readDraftWrap', async () => {
    const author = newSigner()
    const draft = {
      switch_id: 's1',
      message: 'hello',
      recipient: '0'.repeat(64),
      interval: 7 * 86400,
      updated_at: now,
    }
    const wrap = await createDraftWrap(author.signer, draft)
    const read = await readDraftWrap(author.signer, wrap)
    expect(read).toEqual({ v: 1, type: 'lastpub-draft', ...draft })
  })

  it('a foreign signer cannot read the draft', async () => {
    const author = newSigner()
    const wrap = await createDraftWrap(author.signer, {
      switch_id: 's1',
      message: 'private',
      recipient: '0'.repeat(64),
      interval: 1000,
      updated_at: now,
    })
    await expect(readDraftWrap(newSigner().signer, wrap)).rejects.toThrow()
  })
})

describe('5905-Job (§1.4)', () => {
  it('Round-Trip: buildJobRequest → decryptJobRequest (Tower)', async () => {
    const author = newSigner()
    const tower = newSigner()
    const towerPub = getPublicKey(tower.sk)
    const { wrap } = await createCapsule(author.signer, {
      plaintext: 'x',
      recipient: getPublicKey(newSigner().sk),
      round: roundForTime(now + 86400),
      now,
      tlock,
    })
    const job = await buildJobRequest(author.signer, {
      wrap,
      publishAt: now + 86400,
      relays: ['wss://relay.example', 'wss://relay2.example'],
      tower: towerPub,
    })
    expect(job.kind).toBe(5905)
    expect(job.tags).toContainEqual(['encrypted'])
    expect(job.tags).toContainEqual(['p', towerPub])
    // content is encrypted — wrap JSON must not appear in plaintext
    expect(job.content).not.toContain(wrap.id)

    const parsed = await decryptJobRequest(tower.signer, job)
    expect(parsed.author).toBe(getPublicKey(author.sk))
    expect(parsed.requestId).toBe(job.id)
    expect(parsed.wrap.id).toBe(wrap.id)
    expect(parsed.publishAt).toBe(now + 86400)
    expect(parsed.relays).toEqual(['wss://relay.example', 'wss://relay2.example'])
  })

  it('a foreign tower cannot decrypt the request', async () => {
    const author = newSigner()
    const tower = newSigner()
    const { wrap } = await createCapsule(author.signer, {
      plaintext: 'x',
      recipient: getPublicKey(newSigner().sk),
      round: roundForTime(now + 86400),
      now,
      tlock,
    })
    const job = await buildJobRequest(author.signer, {
      wrap,
      publishAt: now + 86400,
      relays: [],
      tower: getPublicKey(tower.sk),
    })
    await expect(decryptJobRequest(newSigner().signer, job)).rejects.toThrow()
  })

  it('buildCancel references the job via e tag and the tower via p tag (NIP-09)', async () => {
    const author = newSigner()
    const cancel = await buildCancel(author.signer, 'a'.repeat(64), 'c'.repeat(64))
    expect(cancel.kind).toBe(5)
    expect(cancel.tags).toContainEqual(['e', 'a'.repeat(64)])
    expect(cancel.tags).toContainEqual(['k', '5905'])
    expect(cancel.tags).toContainEqual(['p', 'c'.repeat(64)])
  })
})

describe('Export (§4.5)', () => {
  it('contains wrap, nevent and drand parameters', async () => {
    const author = newSigner()
    const { wrap } = await createCapsule(author.signer, {
      plaintext: 'x',
      recipient: getPublicKey(newSigner().sk),
      round: roundForTime(now + 86400),
      now,
      tlock,
    })
    const exp = buildExport({
      wrap,
      job: { requestId: 'b'.repeat(64), tower: 'c'.repeat(64) },
      publishAt: now + 86400,
      relays: ['wss://r1.example', 'wss://r2.example'],
      now,
    })
    expect(exp.v).toBe(1)
    expect(exp.job.request_id).toBe('b'.repeat(64))
    expect(exp.job.tower).toBe('c'.repeat(64))
    expect(exp.job.publish_at).toBe(now + 86400)
    expect(exp.capsule.wrap.id).toBe(wrap.id)
    expect(exp.drand.genesis).toBe(1692803367)
    const decoded = nip19.decode(exp.capsule.nevent)
    expect(decoded.type).toBe('nevent')
    expect((decoded.data as { id: string }).id).toBe(wrap.id)
    expect((decoded.data as { relays?: string[] }).relays).toEqual([
      'wss://r1.example',
      'wss://r2.example',
    ])
  })
})
