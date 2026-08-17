/** drand quicknet (League of Entropy) — normative constants, spec §0. */
export const QUICKNET = {
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesis: 1692803367,
  period: 3,
  schemeID: 'bls-unchained-g1-rfc9380',
} as const

export type ChainParams = {
  chainHash: string
  genesis: number
  period: number
}

export const DEFAULT_DRAND_URLS = ['https://api.drand.sh', 'https://drand.cloudflare.com']

export const KIND_CAPSULE = 1041
export const KIND_CHECKIN = 1042
export const KIND_SEAL = 13
export const KIND_DRAFT = 14
export const KIND_WRAP = 1059
export const KIND_JOB = 5905
export const KIND_JOB_RESULT = 6900
export const KIND_FEEDBACK = 7000
export const KIND_DELETE = 5
export const KIND_DM_RELAYS = 10050

/** Shugur draft: decoded content > 64 KiB → reject. */
export const MAX_CONTENT_BYTES = 64 * 1024
/** Shugur draft: tlock stanza body SHOULD be ≤ 4096 B. */
export const MAX_TLOCK_BLOB = 4096
/** Replay protection: created_at tolerance against recipient time (±, seconds). */
export const CHECKIN_TOLERANCE_SEC = 600
/** NIP-59: randomize created_at of seal/wrap up to 2 days into the past. */
export const TIMESTAMP_RANDOMIZATION_SEC = 2 * 24 * 3600

export const PRESETS = [
  { interval: 7 * 86400 },
  { interval: 30 * 86400 },
  { interval: 90 * 86400 },
] as const
export const DEFAULT_PRESET = PRESETS[1]
