import { beforeEach, describe, expect, it } from 'vitest'
import { storage } from '../src/lib/storage.js'

/**
 * The web app's localStorage adapter — defaults, the StorageAdapter writes the
 * client uses, and the legacy (flat, single-message) → messages[] migration.
 * The flow logic itself is covered in @lastpub/client.
 */
const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage

beforeEach(() => store.clear())

describe('web storage adapter', () => {
  it('loadSettings falls back to build-time defaults on an empty store', () => {
    const s = storage.loadSettings()
    expect(Array.isArray(s.relays)).toBe(true)
    expect(s.relays.length).toBeGreaterThan(0)
    expect(Array.isArray(s.towerNpubs)).toBe(true)
  })

  it('migrates legacy single-tower settings to towerNpubs[]', () => {
    store.set('lastpub.settings', JSON.stringify({ relays: ['wss://r'], towerNpub: 'npub1x' }))
    expect(storage.loadSettings().towerNpubs).toEqual(['npub1x'])
  })

  it('save/clear switch round-trips through localStorage', () => {
    const sw = {
      switchId: 's1',
      towerPubs: ['abc'],
      interval: 100,
      lastCheckinAt: 1,
      publishAt: 101,
      messages: [],
    }
    storage.saveSwitch(sw as never)
    expect(storage.loadSwitch()?.switchId).toBe('s1')
    storage.clearSwitch()
    expect(storage.loadSwitch()).toBeNull()
  })

  it('migrates a legacy flat single-tower switch to towerPubs[] + placements[]', () => {
    // The oldest shape: recipient/wrap/requestId sat directly on the switch,
    // keyed by a single towerPub, and it still carried grace/roundTime.
    const legacy = {
      switchId: 's2',
      towerPub: 'tower',
      interval: 200,
      grace: 20,
      lastCheckinAt: 2,
      publishAt: 202,
      roundTime: 222,
      recipient: 'recipientHex',
      requestId: 'req9',
      wrap: { id: 'w' },
      wrapEphemeralKey: 'eph',
      draftWrap: { id: 'd' },
    }
    store.set('lastpub.switch', JSON.stringify(legacy))

    const migrated = storage.loadSwitch()
    expect(migrated?.towerPubs).toEqual(['tower'])
    expect(migrated?.messages).toHaveLength(1)
    expect(migrated?.messages[0].recipient).toBe('recipientHex')
    expect(migrated?.messages[0].placements).toEqual([{ towerPub: 'tower', requestId: 'req9' }])
    expect(migrated?.messages[0].concealmentBroken).toBe(false)
    expect(migrated?.messages[0].id).toBeTruthy() // a fresh id was minted
    // dropped fields
    expect((migrated as Record<string, unknown>)?.grace).toBeUndefined()
    expect((migrated as Record<string, unknown>)?.towerPub).toBeUndefined()
  })

  it('discards a legacy pending journal without items', () => {
    store.set('lastpub.pending', JSON.stringify({ checkinAt: 1 }))
    expect(storage.loadPending()).toBeNull()
  })
})
