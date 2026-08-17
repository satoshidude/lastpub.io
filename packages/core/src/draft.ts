import { KIND_DRAFT } from './constants.js'
import { LastpubError } from './errors.js'
import { buildRumor, unwrapToRumor, wrapRumor } from './giftwrap.js'
import type { Signer } from './signer.js'
import type { Event, LastpubDraft, VerifiedEvent } from './types.js'

/**
 * Draft storage (spec §1.5): kind-14 rumor with lastpub-draft JSON,
 * self-gift-wrapped to the own npub. Immutable — every edit produces a
 * new wrap; the current draft is the one with the highest updated_at.
 */
export async function createDraftWrap(
  signer: Signer,
  draft: Omit<LastpubDraft, 'v' | 'type'>,
): Promise<VerifiedEvent> {
  const self = await signer.getPublicKey()
  const payload: LastpubDraft = { v: 1, type: 'lastpub-draft', ...draft }
  const rumor = buildRumor(self, {
    kind: KIND_DRAFT,
    created_at: payload.updated_at,
    content: JSON.stringify(payload),
    tags: [['p', self]],
  })
  return wrapRumor(signer, rumor, self)
}

export async function readDraftWrap(signer: Signer, wrap: Event): Promise<LastpubDraft> {
  const { rumor } = await unwrapToRumor(signer, wrap)
  if (rumor.kind !== KIND_DRAFT) {
    throw new LastpubError('ERR_DRAFT_INVALID', `inner rumor kind ${rumor.kind}, expected 14`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rumor.content)
  } catch {
    throw new LastpubError('ERR_DRAFT_INVALID', 'draft content is not valid JSON')
  }
  const draft = parsed as LastpubDraft
  if (
    draft?.v !== 1 ||
    draft.type !== 'lastpub-draft' ||
    typeof draft.message !== 'string' ||
    typeof draft.recipient !== 'string' ||
    typeof draft.interval !== 'number' ||
    typeof draft.updated_at !== 'number'
  ) {
    throw new LastpubError('ERR_DRAFT_INVALID', 'not a lastpub-draft payload')
  }
  return draft
}
