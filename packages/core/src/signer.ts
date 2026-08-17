import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import type { EventTemplate, VerifiedEvent } from './types.js'

/**
 * Signer abstraction (spec §2.1): browser = NIP-07 extension,
 * Node/tests/tower = LocalSigner with an in-memory key.
 */
export interface Signer {
  getPublicKey(): Promise<string>
  signEvent(e: EventTemplate): Promise<VerifiedEvent>
  nip44Encrypt(peer: string, plaintext: string): Promise<string>
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>
}

export class LocalSigner implements Signer {
  constructor(private readonly secretKey: Uint8Array) {}

  async getPublicKey(): Promise<string> {
    return getPublicKey(this.secretKey)
  }

  async signEvent(e: EventTemplate): Promise<VerifiedEvent> {
    return finalizeEvent(e, this.secretKey)
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return nip44.encrypt(plaintext, nip44.getConversationKey(this.secretKey, peer))
  }

  async nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    return nip44.decrypt(ciphertext, nip44.getConversationKey(this.secretKey, peer))
  }
}

/** NIP-07 signer for the browser (window.nostr). */
export function nip07Signer(nostr: {
  getPublicKey(): Promise<string>
  signEvent(e: EventTemplate): Promise<VerifiedEvent>
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
}): Signer {
  if (!nostr.nip44) {
    throw new Error('NIP-07 extension without nip44 support — lastpub requires nip44')
  }
  const nip44ext = nostr.nip44
  return {
    getPublicKey: () => nostr.getPublicKey(),
    signEvent: (e) => nostr.signEvent(e),
    nip44Encrypt: (peer, pt) => nip44ext.encrypt(peer, pt),
    nip44Decrypt: (peer, ct) => nip44ext.decrypt(peer, ct),
  }
}
