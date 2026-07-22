import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import * as nip19 from 'nostr-tools/nip19'
import WebSocket from 'ws'
import { LocalSigner, unwrapCapsule, decryptCapsule } from '@lastpub/core'
import { MiniRelay, startTower, type RunningTower } from '@lastpub/tower'
import { LastpubClient } from '../src/client.js'
import type { PendingStage5, StorageAdapter, SwitchData } from '../src/types.js'

useWebSocketImplementation(WebSocket)

/**
 * E2E of the client flows (§4): LastpubClient with LocalSigner instead of
 * NIP-07, real capsule crypto (tlock offline), real tower via mini-relay, and
 * an in-memory StorageAdapter in place of a browser's localStorage.
 */
class MemoryStore implements StorageAdapter {
  switch: SwitchData | null = null
  pending: PendingStage5 | null = null
  saveSwitch(s: SwitchData) {
    this.switch = s
  }
  savePending(p: PendingStage5) {
    this.pending = p
  }
  clearPending() {
    this.pending = null
  }
  clearSwitch() {
    this.switch = null
  }
}

describe('LastpubClient E2E (Mini-Relay + Tower)', () => {
  let relay: MiniRelay
  let running: RunningTower
  let store: MemoryStore
  let client: LastpubClient
  let author: LocalSigner
  let recipientSk: Uint8Array

  beforeAll(async () => {
    relay = await MiniRelay.start()
    running = await startTower({
      signer: new LocalSigner(generateSecretKey()),
      relays: [relay.url],
      fallbackRelays: [relay.url],
      tickMs: 100,
    })
    author = new LocalSigner(generateSecretKey())
    recipientSk = generateSecretKey()
    store = new MemoryStore()
    client = new LastpubClient(
      author,
      { relays: [relay.url], towerNpubs: [nip19.npubEncode(running.towerPub)] },
      store,
    )
  })

  afterAll(async () => {
    client.close()
    await running.stop()
    await relay.close()
  })

  it('Create → check-in (with edit) → delete, capsule stays consistent', async () => {
    const authorPub = await author.getPublicKey()
    const recipient = new LocalSigner(recipientSk)

    // Create (§4.2)
    const sw = await client.createSwitch({
      message: 'first draft',
      recipientNpub: nip19.npubEncode(getPublicKey(recipientSk)),
      interval: 30 * 86400,
    })
    expect(sw.publishAt - sw.lastCheckinAt).toBe(30 * 86400)
    expect(sw.messages).toHaveLength(1)
    const firstMsg = sw.messages[0]
    expect(running.db.getJobByRequestId(firstMsg.placements[0].requestId)?.status).toBe('scheduled')
    // job is keyed to the message's own slot (§3.2)
    expect(running.db.getJobByRequestId(firstMsg.placements[0].requestId)?.slot).toBe(firstMsg.id)
    expect(store.switch?.messages[0]?.placements[0]?.requestId).toBe(firstMsg.placements[0].requestId)

    // Capsule is a real 1041 capsule, unwrappable by the recipient
    const { rumor, round } = await unwrapCapsule(recipient, firstMsg.wrap)
    expect(rumor.pubkey).toBe(authorPub)
    expect(round).toBeGreaterThan(0)
    // Decryption correctly fails on the future round (no network call needed)
    await expect(decryptCapsule(rumor)).rejects.toMatchObject({ code: 'ERR_TOO_EARLY' })

    // Read draft (prefilling the edit field)
    expect((await client.readDraft(sw)).message).toBe('first draft')

    // Check-in with edit (§4.3): old job gone, new job present, draft updated
    const before = firstMsg.placements[0].requestId
    const after = await client.checkin(sw, {
      messageId: firstMsg.id,
      message: 'second draft',
    })
    const afterMsg = after.messages[0]
    expect(afterMsg.id).toBe(firstMsg.id) // message keeps its identity
    expect(afterMsg.placements[0].requestId).not.toBe(before)
    expect(running.db.getJobByRequestId(before)).toBeUndefined()
    expect(running.db.getJobByRequestId(afterMsg.placements[0].requestId)?.status).toBe('scheduled')
    expect(running.db.lastCheckinAt(authorPub)).toBe(after.lastCheckinAt)
    expect(store.pending).toBeNull() // success rule satisfied → journal empty
    expect((await client.readDraft(after)).message).toBe('second draft')

    // the recipient would get the edited version (draft chain is correct)
    const renewed = await unwrapCapsule(recipient, afterMsg.wrap)
    expect(renewed.round).toBeGreaterThanOrEqual(round)

    // export contains the current wrap
    const exp = client.buildExportFile(after, afterMsg.id)
    expect(exp.capsule.wrap.id).toBe(afterMsg.wrap.id)
    expect(exp.capsule.nevent).toMatch(/^nevent1/)

    // delete (§4.4): silent, job hard gone
    await client.deleteSwitch(after)
    expect(running.db.getJobByRequestId(afterMsg.placements[0].requestId)).toBeUndefined()
    expect(store.switch).toBeNull()
  }, 30_000)

  it('restore from export and from relay reconstructs a resumable switch', async () => {
    // A fresh author, so the relay view for restore is isolated.
    const a = new LocalSigner(generateSecretKey())
    const towerNpubs = [nip19.npubEncode(running.towerPub)]
    const rSk = generateSecretKey()
    const origin = new LastpubClient(a, { relays: [relay.url], towerNpubs }, new MemoryStore())
    const sw = await origin.createSwitch({
      message: 'recover me',
      recipientNpub: nip19.npubEncode(getPublicKey(rSk)),
      interval: 30 * 86400,
    })
    const msg = sw.messages[0]
    const exp = origin.buildExportFile(sw)
    origin.close()

    // Fresh install #1: import the export file.
    const storeX = new MemoryStore()
    const fromExport = new LastpubClient(a, { relays: [relay.url], towerNpubs }, storeX)
    const rx = await fromExport.restoreFromExport(exp)
    expect(rx.switchId).toBe(sw.switchId)
    expect(rx.interval).toBe(30 * 86400)
    expect(rx.towerPubs).toContain(running.towerPub)
    expect(rx.messages[0].recipient).toBe(msg.recipient)
    expect(rx.messages[0].placements[0].requestId).toBe(msg.placements[0].requestId)
    expect(rx.messages[0].wrap.id).toBe(msg.wrap.id)
    expect(storeX.switch?.switchId).toBe(sw.switchId)
    expect((await fromExport.readDraft(rx)).message).toBe('recover me')
    fromExport.close()

    // Fresh install #2: nothing but the key — rebuild from the relays.
    const storeR = new MemoryStore()
    const fromRelay = new LastpubClient(a, { relays: [relay.url], towerNpubs }, storeR)
    const rr = await fromRelay.restoreFromRelay()
    expect(rr?.switchId).toBe(sw.switchId)
    expect(rr?.towerPubs).toContain(running.towerPub)
    expect(rr?.messages[0].placements[0].requestId).toBe(msg.placements[0].requestId)
    expect(rr?.messages[0].wrap.id).toBe(msg.wrap.id)
    expect((await fromRelay.readDraft(rr!)).message).toBe('recover me')
    fromRelay.close()
  }, 30_000)

  it('redundancy: the same capsule is deposited with every tower', async () => {
    const tower2 = await startTower({
      signer: new LocalSigner(generateSecretKey()),
      relays: [relay.url],
      fallbackRelays: [relay.url],
      tickMs: 100,
    })
    const a = new LocalSigner(generateSecretKey())
    const rSk = generateSecretKey()
    const c = new LastpubClient(
      a,
      {
        relays: [relay.url],
        towerNpubs: [nip19.npubEncode(running.towerPub), nip19.npubEncode(tower2.towerPub)],
      },
      new MemoryStore(),
    )
    const sw = await c.createSwitch({
      message: 'redundant',
      recipientNpub: nip19.npubEncode(getPublicKey(rSk)),
      interval: 30 * 86400,
    })
    const msg = sw.messages[0]
    expect(sw.towerPubs).toHaveLength(2)
    expect(msg.placements).toHaveLength(2)

    // Each tower holds its own job, both pointing at the very same capsule.
    const at = (towerPub: string) => msg.placements.find((p) => p.towerPub === towerPub)!.requestId
    expect(running.db.getJobByRequestId(at(running.towerPub))?.wrap_id).toBe(msg.wrap.id)
    expect(tower2.db.getJobByRequestId(at(tower2.towerPub))?.wrap_id).toBe(msg.wrap.id)

    // A check-in renews the job at both towers (old gone, new scheduled at each).
    const before1 = at(running.towerPub)
    const before2 = at(tower2.towerPub)
    const after = await c.checkin(sw)
    expect(after.messages[0].placements).toHaveLength(2)
    expect(running.db.getJobByRequestId(before1)).toBeUndefined() // tower1's old job cancelled
    expect(tower2.db.getJobByRequestId(before2)).toBeUndefined() // tower2's old job cancelled
    const newAt = (t: string) =>
      after.messages[0].placements.find((p) => p.towerPub === t)!.requestId
    expect(running.db.getJobByRequestId(newAt(running.towerPub))?.status).toBe('scheduled')
    expect(tower2.db.getJobByRequestId(newAt(tower2.towerPub))?.status).toBe('scheduled')

    await c.deleteSwitch(after)
    c.close()
    await tower2.stop()
  }, 30_000)

  it('migration: a check-in moves the switch to the towers in settings', async () => {
    const towerB = await startTower({
      signer: new LocalSigner(generateSecretKey()),
      relays: [relay.url],
      fallbackRelays: [relay.url],
      tickMs: 100,
    })
    const a = new LocalSigner(generateSecretKey())
    const rSk = generateSecretKey()
    const store = new MemoryStore()

    // Create at tower A (the shared `running` tower).
    const atA = new LastpubClient(
      a,
      { relays: [relay.url], towerNpubs: [nip19.npubEncode(running.towerPub)] },
      store,
    )
    const sw = await atA.createSwitch({
      message: 'portable',
      recipientNpub: nip19.npubEncode(getPublicKey(rSk)),
      interval: 30 * 86400,
    })
    const oldReq = sw.messages[0].placements[0].requestId
    expect(running.db.getJobByRequestId(oldReq)?.status).toBe('scheduled')
    atA.close()

    // Same key + storage, but settings now point at tower B — as after a fresh
    // install pointed at a live tower. The check-in migrates the switch.
    const atB = new LastpubClient(
      a,
      { relays: [relay.url], towerNpubs: [nip19.npubEncode(towerB.towerPub)] },
      store,
    )
    const after = await atB.checkin(sw)
    expect(after.towerPubs).toEqual([towerB.towerPub])
    expect(after.messages[0].placements.map((p) => p.towerPub)).toEqual([towerB.towerPub])
    expect(towerB.db.getJobByRequestId(after.messages[0].placements[0].requestId)?.status).toBe(
      'scheduled',
    )
    await new Promise((r) => setTimeout(r, 200)) // let tower A process the drop-cancel
    expect(running.db.getJobByRequestId(oldReq)).toBeUndefined() // dropped tower cancelled

    await atB.deleteSwitch(after)
    atB.close()
    await towerB.stop()
  }, 30_000)
})
