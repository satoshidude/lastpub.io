export type LastpubErrorCode =
  | 'ERR_SIZE_LIMIT'
  | 'ERR_TLOCK_TAG'
  | 'ERR_ROUND_IN_PAST'
  | 'ERR_TOO_EARLY'
  | 'ERR_SEAL_TAGS'
  | 'ERR_PUBKEY_MISMATCH'
  | 'ERR_ID_MISMATCH'
  | 'ERR_RUMOR_PTAG'
  | 'ERR_WRAP_INVALID'
  | 'ERR_DRAFT_INVALID'
  | 'ERR_BEACON_UNAVAILABLE'
  | 'ERR_BEACON_INVALID'
  | 'ERR_NIP07_DENIED'

export class LastpubError extends Error {
  constructor(
    public readonly code: LastpubErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'LastpubError'
  }
}
