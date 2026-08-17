import { Buffer } from 'buffer'
import { LastpubError } from './errors.js'

/**
 * Minimal parser for the age v1 header (binary format, spec §1.2).
 * Reads only version + recipient stanzas — no decryption.
 */

export type AgeStanza = { type: string; args: string[] }

const AGE_VERSION_LINE = 'age-encryption.org/v1'
const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----'

/** Uint8Array ↔ "binary string" (latin1) — encoding tlock-js uses internally. */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return s
}

export function binaryStringToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff
  return bytes
}

/** RFC 4648 padded, no line breaks (Shugur requirement). */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

export function isArmored(bytes: Uint8Array): boolean {
  return bytesToBinaryString(bytes.subarray(0, ARMOR_BEGIN.length)) === ARMOR_BEGIN
}

/**
 * Parses the header of a binary age v1 file.
 * Throws ERR_TLOCK_TAG for armored input or malformed structure.
 */
export function parseAgeHeader(bytes: Uint8Array): { version: string; stanzas: AgeStanza[] } {
  if (isArmored(bytes)) {
    throw new LastpubError('ERR_TLOCK_TAG', 'ASCII-armored age is not allowed (binary required)')
  }
  const text = bytesToBinaryString(bytes)
  const macIdx = text.indexOf('\n--- ')
  if (macIdx < 0) {
    throw new LastpubError('ERR_TLOCK_TAG', 'invalid age v1 file: missing header MAC line')
  }
  const headerLines = text.slice(0, macIdx).split('\n')
  const version = headerLines[0]
  if (version !== AGE_VERSION_LINE) {
    throw new LastpubError('ERR_TLOCK_TAG', `invalid age version line: ${version}`)
  }
  const stanzas: AgeStanza[] = []
  for (const line of headerLines.slice(1)) {
    if (line.startsWith('-> ')) {
      const tokens = line.slice(3).split(' ')
      stanzas.push({ type: tokens[0], args: tokens.slice(1) })
    }
    // other lines are the base64 body of the current stanza — irrelevant for the check
  }
  if (stanzas.length === 0) {
    throw new LastpubError('ERR_TLOCK_TAG', 'age file contains no recipient stanza')
  }
  return { version, stanzas }
}

/**
 * Checks the Shugur rules on the decoded content:
 * exactly one stanza, type tlock, args = [round, chainHash] matching the event tag.
 * Note the order: the age stanza writes round first, the event tag writes chain first.
 */
export function assertSingleTlockStanza(
  bytes: Uint8Array,
  expected: { chainHash: string; round: string },
): void {
  const { stanzas } = parseAgeHeader(bytes)
  if (stanzas.length !== 1) {
    throw new LastpubError('ERR_TLOCK_TAG', `expected exactly one stanza, got ${stanzas.length}`)
  }
  const s = stanzas[0]
  if (s.type !== 'tlock') {
    throw new LastpubError('ERR_TLOCK_TAG', `expected tlock stanza, got "${s.type}"`)
  }
  if (s.args.length !== 2) {
    throw new LastpubError('ERR_TLOCK_TAG', `tlock stanza expects 2 args, got ${s.args.length}`)
  }
  const [round, chainHash] = s.args
  if (round !== expected.round || chainHash !== expected.chainHash) {
    throw new LastpubError(
      'ERR_TLOCK_TAG',
      `stanza (round=${round}, chain=${chainHash}) does not match tag (round=${expected.round}, chain=${expected.chainHash})`,
    )
  }
}
