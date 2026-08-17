import { timelockEncrypt, timelockDecrypt, HttpChainClient } from 'tlock-js'
import { decodeArmor, isProbablyArmored } from 'tlock-js/age/armor.js'
import { Buffer } from 'buffer'
import { QUICKNET, DEFAULT_DRAND_URLS } from './constants.js'
import { LastpubError } from './errors.js'
import { binaryStringToBytes, bytesToBinaryString } from './age.js'

/**
 * tlock engine abstraction (spec §2): operates on binary age v1.
 * Default = drand quicknet via tlock-js; tests inject a fake engine.
 */
export interface TlockEngine {
  readonly chainHash: string
  encrypt(round: number, plaintext: Uint8Array): Promise<Uint8Array>
  decrypt(ageBinary: Uint8Array): Promise<Uint8Array>
}

const CHAIN_INFO = {
  public_key: QUICKNET.publicKey,
  period: QUICKNET.period,
  genesis_time: QUICKNET.genesis,
  hash: QUICKNET.chainHash,
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: QUICKNET.schemeID,
  metadata: { beaconID: 'quicknet' },
}

/**
 * ChainClient with static chain info: encryption runs entirely offline,
 * only the beacon fetch on decrypt goes over the network. Beacon verification
 * (BLS against the embedded public key) stays active — Shugur MUST.
 */
function quicknetClient(baseUrl: string): HttpChainClient {
  const chain = {
    baseUrl: `${baseUrl}/${QUICKNET.chainHash}`,
    info: async () => CHAIN_INFO,
  }
  return new HttpChainClient(
    chain as never,
    {
      disableBeaconVerification: false,
      noCache: false,
      chainVerificationParams: {
        chainHash: QUICKNET.chainHash,
        publicKey: QUICKNET.publicKey,
      },
    },
    { userAgent: 'lastpub-core' },
  )
}

export class QuicknetTlockEngine implements TlockEngine {
  readonly chainHash = QUICKNET.chainHash

  constructor(private readonly urls: string[] = DEFAULT_DRAND_URLS) {}

  async encrypt(round: number, plaintext: Uint8Array): Promise<Uint8Array> {
    // Chain info is static — the first configured endpoint is enough, offline.
    const armored = await timelockEncrypt(round, Buffer.from(plaintext), quicknetClient(this.urls[0]))
    return binaryStringToBytes(decodeArmor(armored))
  }

  async decrypt(ageBinary: Uint8Array): Promise<Uint8Array> {
    const cipher = bytesToBinaryString(ageBinary)
    if (isProbablyArmored(cipher)) {
      throw new LastpubError('ERR_TLOCK_TAG', 'ASCII-armored age is not allowed (binary required)')
    }
    let lastError: unknown
    for (const url of this.urls) {
      try {
        const plain = await timelockDecrypt(cipher, quicknetClient(url))
        return new Uint8Array(plain)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('too early')) {
          throw new LastpubError('ERR_TOO_EARLY', msg, { cause: e })
        }
        if (msg.toLowerCase().includes('verif')) {
          throw new LastpubError('ERR_BEACON_INVALID', msg, { cause: e })
        }
        lastError = e
      }
    }
    throw new LastpubError('ERR_BEACON_UNAVAILABLE', 'no drand endpoint reachable', {
      cause: lastError,
    })
  }
}

let defaultEngine: TlockEngine | undefined

export function getDefaultTlockEngine(): TlockEngine {
  if (!defaultEngine) defaultEngine = new QuicknetTlockEngine()
  return defaultEngine
}
