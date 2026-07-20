#!/usr/bin/env node
/**
 * Local dev stack: mini relay (port 7777) + reference tower with a persistent
 * key, so the web app can develop against a stable tower npub.
 *
 *   node scripts/dev-stack.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { generateSecretKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { LocalSigner } from '@lastpub/core'
import { MiniRelay, startTower } from '@lastpub/tower'

const KEY_FILE = new URL('../.dev-tower-key', import.meta.url)

function loadOrCreateKey() {
  if (existsSync(KEY_FILE)) {
    return new Uint8Array(Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex'))
  }
  const sk = generateSecretKey()
  writeFileSync(KEY_FILE, Buffer.from(sk).toString('hex') + '\n', { mode: 0o600 })
  return sk
}

const relay = await MiniRelay.start(7777)
const signer = new LocalSigner(loadOrCreateKey())
const { towerPub } = await startTower({
  signer,
  relays: [relay.url],
  fallbackRelays: [relay.url],
  dbPath: new URL('../dev-tower.sqlite', import.meta.url).pathname,
  log: console.log,
})

console.log('')
console.log('── lastpub dev stack ──────────────────────────────')
console.log(`Relay:      ${relay.url}`)
console.log(`Tower npub: ${nip19.npubEncode(towerPub)}`)
console.log('Web app settings: enter the relay URL + tower npub above.')
console.log('Stop with Ctrl-C.')
