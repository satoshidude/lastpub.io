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
      { relays: [relay.url], towerNpub: nip19.npubEncode(running.towerPub) },
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
    expect(running.db.getJobByRequestId(firstMsg.requestId)?.status).toBe('scheduled')
    // job is keyed to the message's own slot (§3.2)
    expect(running.db.getJobByRequestId(firstMsg.requestId)?.slot).toBe(firstMsg.id)
    expect(store.switch?.messages[0]?.requestId).toBe(firstMsg.requestId)

    // Capsule is a real 1041 capsule, unwrappable by the recipient
    const { rumor, round } = await unwrapCapsule(recipient, firstMsg.wrap)
    expect(rumor.pubkey).toBe(authorPub)
    expect(round).toBeGreaterThan(0)
    // Decryption correctly fails on the future round (no network call needed)
    await expect(decryptCapsule(rumor)).rejects.toMatchObject({ code: 'ERR_TOO_EARLY' })

    // Read draft (prefilling the edit field)
    expect((await client.readDraft(sw)).message).toBe('first draft')

    // Check-in with edit (§4.3): old job gone, new job present, draft updated
    const before = firstMsg.requestId
    const after = await client.checkin(sw, {
      messageId: firstMsg.id,
      message: 'second draft',
    })
    const afterMsg = after.messages[0]
    expect(afterMsg.id).toBe(firstMsg.id) // message keeps its identity
    expect(afterMsg.requestId).not.toBe(before)
    expect(running.db.getJobByRequestId(before)).toBeUndefined()
    expect(running.db.getJobByRequestId(afterMsg.requestId)?.status).toBe('scheduled')
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
    expect(running.db.getJobByRequestId(afterMsg.requestId)).toBeUndefined()
    expect(store.switch).toBeNull()
  }, 30_000)
})
