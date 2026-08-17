#!/usr/bin/env node
import * as nip19 from 'nostr-tools/nip19'
import { LocalSigner } from '@lastpub/core'
import { startTower } from './run.js'

/**
 * Operations entry point (design doc §3): configuration via env.
 *   TOWER_SECRET_KEY      hex or nsec (required)
 *   TOWER_RELAYS          Comma-separated: relays for ingress + feedback (required)
 *   TOWER_FALLBACK_RELAYS Comma-separated: broadcast fallback set (§3.4)
 *   TOWER_DB              SQLite path (default: ./tower.sqlite)
 */

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`missing env ${name}`)
    process.exit(1)
  }
  return v
}

function parseSecretKey(input: string): Uint8Array {
  if (input.startsWith('nsec1')) {
    const decoded = nip19.decode(input)
    if (decoded.type !== 'nsec') throw new Error('not an nsec')
    return decoded.data
  }
  return new Uint8Array(Buffer.from(input, 'hex'))
}

const DEFAULT_FALLBACK = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
]

const fallbackEnv = (process.env.TOWER_FALLBACK_RELAYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

startTower({
  signer: new LocalSigner(parseSecretKey(requireEnv('TOWER_SECRET_KEY'))),
  relays: requireEnv('TOWER_RELAYS').split(',').map((s) => s.trim()),
  fallbackRelays: fallbackEnv.length ? fallbackEnv : DEFAULT_FALLBACK,
  dbPath: process.env.TOWER_DB ?? './tower.sqlite',
  log: console.log,
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
