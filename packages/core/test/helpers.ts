import { generateSecretKey } from 'nostr-tools/pure'
import { LocalSigner } from '../src/signer.js'
import type { TlockEngine } from '../src/tlock.js'
import { bytesToBase64, base64ToBytes, parseAgeHeader } from '../src/age.js'
import { QUICKNET } from '../src/constants.js'
import { LastpubError } from '../src/errors.js'

export function newSigner(): { signer: LocalSigner; sk: Uint8Array } {
  const sk = generateSecretKey()
  return { signer: new LocalSigner(sk), sk }
}

/**
 * Fake engine for offline tests: builds a structurally correct age v1 header
 * with a tlock stanza; the stanza body carries the plaintext (insecure, test only).
 */
export class FakeTlockEngine implements TlockEngine {
  constructor(
    readonly chainHash: string = QUICKNET.chainHash,
    private readonly currentRound: number = Number.MAX_SAFE_INTEGER,
  ) {}

  async encrypt(round: number, plaintext: Uint8Array): Promise<Uint8Array> {
    const body = bytesToBase64(plaintext)
    const header = `age-encryption.org/v1\n-> tlock ${round} ${this.chainHash}\n${body}\n--- fakemac\n`
    const headerBytes = new TextEncoder().encode(header)
    const payload = new Uint8Array(headerBytes.length + 16)
    payload.set(headerBytes)
    return payload
  }

  async decrypt(ageBinary: Uint8Array): Promise<Uint8Array> {
    const { stanzas } = parseAgeHeader(ageBinary)
    const s = stanzas[0]
    if (Number(s.args[0]) > this.currentRound) {
      throw new LastpubError('ERR_TOO_EARLY', 'too early to decrypt')
    }
    const text = new TextDecoder().decode(ageBinary)
    const bodyLine = text.split('\n')[2]
    return base64ToBytes(bodyLine)
  }
}
