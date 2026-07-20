# lastpub — Protocol and Reference Implementation Specification

**Date:** 17 July 2026
**Status:** Implementation specification

**Scope:** protocol (event kinds, tag structures, encryption layering), crypto library `@lastpub/core`, reference scheduler ("tower"), minimal client UI, standalone decrypt page.
**Technology decision:** Node/TypeScript for client **and** scheduler — one ecosystem, the crypto lib `@lastpub/core` is reused in the scheduler for verification, no duplicate implementation.

---

## 0. External spec versions (pinned)

| Spec | Source | Pinned version |
|---|---|---|
| Time Capsules (Kind 1041) | github.com/Shugur-Network/NIP-XX_Time-Capsules | Commit `29279fcf39015cb2da256954cf0c32f53600135b` (2025-09-13) |
| DVM Kind 5905 | github.com/nostr-protocol/data-vending-machines, `kinds/5905.md` | Commit `83915353e316a3e423b912e644bc3ec29ec13f29` (2024-12-26) |
| NIP-44 v2 / NIP-59 / NIP-17 / Kind 10050 | github.com/nostr-protocol/nips (44.md, 59.md, 17.md) | merged, stable |
| tlock-js | github.com/drand/tlock-js | v0.9.0 (npm), quicknet-capable, Kudelski-audited |
| drand quicknet | docs.drand.love | in production (League of Entropy) |

**Kind 1041 status:** single-vendor draft (Shugur), not merged into nostr-protocol/nips. Kinds 1041 and 1042 are **free** in the official kind table (jump from 1040 to 1059). Consequences: §6.

**drand quicknet constants (normative for lastpub):**

```
CHAIN_HASH = 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
GENESIS    = 1692803367   (Unix, 2023-08-23 15:09:27 UTC)
PERIOD     = 3            (seconds)
SCHEME     = bls-unchained-g1-rfc9380
```

---

## 1. Protocol specification (normative)

### 1.1 Time model — formulas

Two parameters per switch: `interval` and `grace` (seconds, internal; UI shows days).

```
deadline   = last_checkin_at + interval
publish_at = deadline                          // trigger, no grace period
round_time = deadline + grace
round      = max(1, ceil((round_time − GENESIS) / PERIOD) + 1)
```

The beacon of round r appears at `GENESIS + (r − 1) · PERIOD` — round 1 lies **on** the genesis (drand reference, `drand-client` `roundTime`). `round` is thus the smallest round whose beacon does not appear before `round_time`.

**Invariant:** `round_time − publish_at = grace`. The client computes both values itself; the scheduler needs no knowledge of the time model.

**Presets:** 7 d / 3 d · **30 d / 5 d (default)** · 90 d / 7 d.

**Edge cases:**

- **Client clock skew:** the client takes `last_checkin_at` from the `created_at` of the 1042 confirmed by the tower (not from the local clock). This way client and tower compute against the same anchor.
- **Round already past** (`round_time ≤ now` at capsule build time): hard client error `ERR_ROUND_IN_PAST` — capsule is not built. Cannot occur under normal operation (`round_time = deadline + grace > now`), but catches clock defects.
- **drand outage:** affects only decryption (delays it); trigger/publish are unaffected. The decrypt page shows the state "beacon unavailable, try again later" when drand endpoints are unreachable (§5.4).
- **Scheduler delay:** permitted non-normatively; any delay shortens the real revocation window. The reference scheduler targets broadcast ≤ 60 s after `publish_at` (§3.5).

### 1.2 Capsule structure (per Shugur draft, pinned version)

Four layers, from inside out:

**(1) Plaintext** — the message (UTF-8; MVP: text).

**(2) tlock:** binary age-v1 format via tlock-js, **exactly one** tlock recipient stanza (CHAIN_HASH, `round`), no other stanza types, **not** ASCII-armored. `tlock_blob ≤ 4096 B` (SHOULD). Base64 (RFC 4648, padded, no line breaks).

**(3) Rumor (Kind 1041, unsigned):**

```json
{
  "kind": 1041,
  "created_at": <unix>,
  "content": "<base64(binary age v1 tlock)>",
  "tags": [
    ["tlock", "<CHAIN_HASH>", "<round>"],
    ["alt", "lastpub time capsule"]
  ],
  "pubkey": "<author>"
}
```

- Exactly **one** `tlock` tag; chain/round MUST match the age stanza (otherwise reject).
- **No `p` tags** in the rumor (MUST, Shugur) — the recipient appears only in the gift wrap. This keeps the recipient identity concealed at the rumor layer.
- No `sig` field. `id` is recomputed on unwrapping; mismatch → reject.
- Decoded content > 64 KiB → client reject (Shugur).

**(4) Seal (Kind 13) + Gift Wrap (Kind 1059)** — exactly per NIP-59:

- Seal: `content = nip44_v2_encrypt(json(rumor), author → recipient)`, `tags = []` (MUST), signed by the author (forgery protection).
- Wrap: `content = nip44_v2_encrypt(json(seal), ephemeral → recipient)`, fresh ephemeral key per wrap, at least one `["p", "<recipient>"]` tag, signed with the ephemeral key.
- `created_at` of seal and wrap is randomized (SHOULD, NIP-59: up to 2 days into the past) — metadata privacy.
- Unwrapping (recipient): verify wrap signature → nip44-decrypt → seal: check `tags = []` and author signature → nip44-decrypt → rumor: check `seal.pubkey == rumor.pubkey`, recompute `id`. The canonical timestamp is `rumor.created_at`.

The finished wrap remains **exclusively** with the 5905 schedulers until trigger (withholding).

### 1.3 Check-in event Kind 1042 (PR-ready specification)

Normative are exclusively `kind`, `pubkey`, `created_at`, `sig`. Full spec text for the NIPs PR:

> **Kind 1042 — Proof of Liveness (Check-in)**
>
> A `kind:1042` event is a signed, otherwise empty event whose only semantic is: *the author was alive and in control of their key at `created_at`*. It is consumed by dead-man's-switch services and similar liveness-dependent protocols.
>
> ```json
> {
>   "kind": 1042,
>   "created_at": <unix>,
>   "content": "",
>   "tags": [],
>   "pubkey": "<author>",
>   "sig": "<schnorr sig>"
> }
> ```
>
> - `content` SHOULD be empty; clients MUST ignore it.
> - All tags are OPTIONAL and advisory. Defined tags: `["t", "lastpub-checkin"]` (topic marker), `["switch", "<switch-id>"]` (disambiguation when an author operates several switches), `["expiration", ...]` (NIP-40, advisory only when delivered privately).
> - Consumers MUST verify the signature and MUST apply replay protection:
>   1. `created_at` strictly greater than the last accepted 1042 of this pubkey,
>   2. `created_at` within a tight tolerance of receiver time (RECOMMENDED ±10 minutes),
>   3. already-seen event ids are discarded.
> - Privacy: a 1042 SHOULD NOT be published to public relays. It SHOULD be delivered NIP-44-encrypted / gift-wrapped to the consuming service's pubkey.

**Additional lastpub rules (binding):**

- Signature via NIP-07; the tower verifies signature + switch ownership (author pubkey = job submitter).
- Towers (including pure observers) reset their timer **exclusively** on a valid 1042.
- The 1042 is at the same time the revocation instrument in the grace window (§4.4).
- **Delivery path:** NIP-59 gift wrap to the tower npub, `["p", <tower>]` tag on the wrap. No public relay.

**Registry:** Kind 1042 is free. Reservation happens exclusively via a complete spec PR against `nostr-protocol/nips` (kind table in README.md + spec text). Own task, to be submitted before launch (§6).

### 1.4 Scheduler interface: Kind 5905

Basis: `kinds/5905.md` ("Nostr Event Publish Schedule", pinned) + NIP-90 framework.

**Job request (Kind 5905), plaintext structure:**

```json
{
  "kind": 5905,
  "content": "",
  "tags": [
    ["i", "<json(gift-wrap-event 1059)>", "text"],
    ["param", "relays", "<relay1>", "<relay2>", "..."],
    ["param", "publish_at", "<unix>"],
    ["p", "<tower-pubkey>"]
  ]
}
```

- `i` tag: the finished, ready-to-publish gift wrap event as a string (registry-compliant).
- `relays`: target relays for the broadcast (registry-compliant). The client populates them at job time with the fallback set (§3.4); the tower performs the **final** relay resolution via Kind 10050 at trigger time (the more current one wins).
- `param publish_at`: **lastpub extension** — the registry doc defines no time parameter, even though "schedule for future publishing" is the stated purpose. Without it, the tower would have to guess `publish_at`. Unix seconds, normative for the trigger.
- The published event carries the ephemeral key of the wrap — the tower does not re-sign anything, it broadcasts the pre-signed 1059 unchanged.

**Encryption of the request (decision):** the registry doc uses NIP-04. **lastpub uses NIP-44 v2** (NIP-90 permits encryption in general; NIP-04 is deprecated and cryptographically weaker): `content = nip44_v2_encrypt(json(i/param-tags), author → tower)`, tags on the event: `["p", <tower>]`, `["encrypted"]`. The reference tower accepts **only** NIP-44 requests.

**Tower responses:**

- **Feedback Kind 7000** (encrypted to the author): `["status", "success", "scheduled"]` + `["e", <job-request-id>]` + `["p", <author>]` + `["encrypted"]`. Sent immediately after acceptance — this is the **stage-5 confirmation** of the success rule (§4.3). Other statuses: `error` with a machine code in the third field (`invalid-wrap`, `round-in-past`, `internal-error`, …).
- **Result Kind 6900** (registry-compliant; the registry doc's own +1000 convention would suggest 6905, but 6900 is what the registry actually defines, so lastpub follows the published registry): after successful broadcast, `content` = event ID of the published 1059.

**Cancellation (lastpub convention, since not specified in the registry doc):** NIP-09 Kind-5 delete request by the author, referencing the 5905 request event via `e` tag and addressing the tower via `p` tag (whose subscription filters on `#p`). Tower checks: Kind-5 author == job author → delete job including wrap (withholding store), confirmation via 7000 `["status", "success", "cancelled"]`. "Renew" = Kind-5 cancellation + new 5905 job.

### 1.5 Draft storage (self-gift-wrap)

- **Decision:** the draft (plaintext + metadata) is wrapped as a rumor with `kind: 14` (NIP-17 chat rumor) **to the author's own npub** — deliberately not as Kind 1041 (would collide semantically with capsules). `content` = JSON:

```json
{
  "v": 1,
  "type": "lastpub-draft",
  "switch_id": "<uuid>",
  "message": "<plaintext>",
  "recipient": "<npub/hex>",
  "interval": <sec>,
  "grace": <sec>,
  "updated_at": <unix>
}
```

  Rationale: Kind 14 in a self-wrap is readable by any NIP-17-capable client as a "note to self" (resilience: the draft remains accessible even without lastpub software); the `type` field prevents confusion.
- Storage: lastpub server (master) **and** author's relays (self-wrap, `p` = own npub). Never relays alone.
- Immutable: every edit = new self-wrap; cleanup of old wraps via NIP-09 best effort.
- The current draft is identified via the highest `updated_at` in the unpacked JSON (not via wrap `created_at` — that is randomized).

---

## 2. Crypto library `@lastpub/core` (TypeScript)

Isolated, backend-free lib (runs in browser and Node). Dependencies: `tlock-js ^0.9`, `nostr-tools` (modules `nip44`, `nip59`, `nip19`, `pure`). No further runtime deps.

### 2.1 API

```ts
// Signer abstraction: browser = NIP-07 extension, Node/tests = key in memory
interface Signer {
  getPublicKey(): Promise<string>
  signEvent(e: EventTemplate): Promise<VerifiedEvent>
  nip44Encrypt(peer: string, plaintext: string): Promise<string>
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>
}

// Time model (pure functions, no IO)
computeSchedule(lastCheckinAt: number, interval: number, grace: number):
  { deadline: number; publishAt: number; roundTime: number; round: number }

// Build capsule: plaintext → tlock → rumor → seal → wrap
createCapsule(signer: Signer, args: {
  plaintext: string; recipient: string; round: number
}): Promise<{ wrap: VerifiedEvent; rumorId: string }>

// Check-in artifacts
createCheckin(signer: Signer, args?: { switchId?: string }): Promise<VerifiedEvent>   // 1042
renewCapsule(signer: Signer, args: {                                                  // stages 2–4
  draftWrap: Event; interval: number; grace: number; lastCheckinAt: number
}): Promise<{ wrap: VerifiedEvent; round: number; publishAt: number }>

// Scheduler side (tower uses the same lib)
buildJobRequest(signer: Signer, args: { wrap: Event; publishAt: number; relays: string[]; tower: string }): Promise<VerifiedEvent>  // 5905, NIP-44
buildCancel(signer: Signer, jobRequestId: string): Promise<VerifiedEvent>             // Kind 5
verifyCheckin(e: Event, state: { lastCreatedAt: number; seenIds: Set<string>; now: number }):
  { ok: true } | { ok: false; reason: 'sig' | 'monotonic' | 'tolerance' | 'replay' }
verifyCapsuleWrap(e: Event): { ok: true } | { ok: false; reason: string }             // structural checks without decrypt

// Recipient side
unwrapCapsule(signer: Signer, wrap: Event): Promise<{ rumor: Rumor; round: number; chain: string }>
decryptCapsule(rumor: Rumor, opts?: { drandUrls?: string[] }): Promise<string>        // fetches+verifies beacon via tlock-js

// Draft
createDraftWrap(signer: Signer, draft: LastpubDraft): Promise<VerifiedEvent>
readDraftWrap(signer: Signer, wrap: Event): Promise<LastpubDraft>

// Export
buildExport(args: { wrap: Event; jobRequestId: string; tower: string; draftWrap?: Event }): LastpubExportV1
```

**Error taxonomy** (error subclasses with `code`): `ERR_SIZE_LIMIT` (decoded > 64 KiB), `ERR_TLOCK_TAG` (tag/stanza mismatch, multiple stanzas, armored), `ERR_ROUND_IN_PAST`, `ERR_SEAL_TAGS` (seal tags ≠ []), `ERR_PUBKEY_MISMATCH` (seal ≠ rumor), `ERR_ID_MISMATCH` (rumor id), `ERR_RUMOR_PTAG` (p tag in rumor), `ERR_BEACON_UNAVAILABLE`, `ERR_BEACON_INVALID`, `ERR_NIP07_DENIED`.

### 2.2 NIP-07 prompt budget

Exact extension call sequences (whether each individual one prompts depends on the extension policy — Alby/nos2x can grant blanket approval; the UI shows the expected signature steps before each flow):

| Flow | Calls |
|---|---|
| Create | `getPublicKey` · draft: `nip44Encrypt(self)` + `signEvent(13)` · capsule: `nip44Encrypt(recipient)` + `signEvent(13)` · job: `nip44Encrypt(tower)` + `signEvent(5905)` |
| Check-in without edit | `signEvent(1042)` · `nip44Decrypt(self)` (draft) · capsule: `nip44Encrypt(recipient)` + `signEvent(13)` · `signEvent(5)` (cancellation) · job: `nip44Encrypt(tower)` + `signEvent(5905)` |
| Check-in with edit | as above + draft anew: `nip44Encrypt(self)` + `signEvent(13)` |
| Delete | `signEvent(5)` + `nip44Encrypt(tower)` |
| Decrypt (recipient) | `nip44Decrypt` ×2 (wrap, seal) |

Note: the re-encryption (new round) mandatorily requires seal-encrypt+sign; the flow cannot work with fewer than 4 signer calls. 2–3 **visible** prompts are realistic only with a standing extension approval for nip44.

### 2.3 Test plan

- **Round trip:** create → unwrap → (time travel: fixed historical round) decrypt == plaintext.
- **Renew:** `renewCapsule` twice → new round, new wrap, same plaintext; old wrap still decrypts (burned ≠ unusable — the basis of the revocation model).
- **Negative vectors** per error code (armored age, second stanza, tag mismatch, p tag in rumor, seal with tags, tampered rumor id, 64 KiB+1).
- **Replay suite** for `verifyCheckin`: older created_at, same created_at, ±10-minute boundaries, event ID dedup.
- **Interop:** open a public capsule (1041) generated with capsules.shugur.com using `decryptCapsule`; validate a lastpub capsule there (manual gate test before launch).
- **Beacon:** `decryptCapsule` against real quicknet beacons (historical round, needs network, marked as `integration` tests) + mocked drand endpoint with an invalid signature → `ERR_BEACON_INVALID`.
- Formula fixtures: `computeSchedule` against manually computed quicknet rounds (including the genesis edge case `max(1, …)`).

---

## 3. Reference scheduler "Tower" (Node + SQLite)

One process, idempotent, crash-safe. Uses `@lastpub/core` for verification. Communication exclusively via Nostr events (relay subscription on `p`-tagged events to the tower npub); no HTTP API in this MVP.

### 3.1 SQLite schema

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,     -- 5905 event ID
  author TEXT NOT NULL,                -- author pubkey (from 5905 signature)
  slot TEXT NOT NULL DEFAULT '',       -- per-message slot; '' = single message
  wrap_json TEXT NOT NULL,             -- withheld 1059
  wrap_id TEXT NOT NULL,
  publish_at INTEGER NOT NULL,
  relays_json TEXT NOT NULL,           -- client suggestion (fallback set)
  status TEXT NOT NULL DEFAULT 'scheduled',
    -- scheduled | publishing | published
  attempts INTEGER NOT NULL DEFAULT 0, -- broadcast attempts (retry backoff)
  result_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, publish_at);
CREATE INDEX idx_jobs_author_slot ON jobs(author, slot);

CREATE TABLE checkins (
  author TEXT PRIMARY KEY,
  last_created_at INTEGER NOT NULL     -- monotonicity anchor
);
CREATE TABLE seen_events (             -- replay/dedup window
  event_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
```

`seen_events` is cleaned up after 48 h (the monotonicity anchor in `checkins` renders older IDs unusable anyway).

### 3.2 Job acceptance (5905)

1. NIP-44 decrypt the request, verify signature.
2. `verifyCapsuleWrap` on the embedded 1059 (structural check without content).
3. Consistency: `publish_at` in the future; the wrap's round is not verifiable (it is inside the rumor) — deliberate: the tower does not know the round (withholding + privacy). Responsibility for the invariant lies with the client (`@lastpub/core` enforces it).
4. **One job per (author, slot):** the request MAY carry a `["param","slot",<id>]` (inside the encrypted payload, so only the tower sees it). The tower keys scheduled jobs on `(author, slot)`; a new job atomically replaces the same author's existing `scheduled` job **for the same slot** (implicit renewal). Distinct slots coexist, so one author can hold several withheld messages at once, each with its own trigger. An omitted slot defaults to `""`, which reproduces the classic one-job-per-author behaviour.

   Consequence for lost cancellations: with per-slot keying, a new job for slot A no longer displaces a stale job for slot B, so the old "any new job cancels everything" self-healing (§3.5) no longer covers a lost `Kind 5`. Deleting a message is therefore complete only once its `cancelled` feedback is observed (mirrors the success rule, §4.3); the client's retry journal re-sends unconfirmed cancellations. On check-in the client renews every currently active slot, so each live message's job is refreshed.
5. Persist, then send 7000 `success/scheduled`. Order matters: commit first, then confirmation (the confirmation is the stage-5 commitment of the success rule).

### 3.3 1042 processing

1. Unwrap gift wrap to the tower npub → inner 1042.
2. `verifyCheckin` (signature, monotonicity against `checkins.last_created_at`, ±10 min against server time, `seen_events`).
3. Switch ownership: a job exists with `author == pubkey` (status `scheduled` **or** `published` with `now < publish_at_round_time` — grace window, revocation §4.4). Otherwise ignore.
4. Valid → update `checkins.last_created_at`. **No timer reset in the job:** the timer reset materializes only through the new 5905 job (stage 5). The tower itself never extends unilaterally — otherwise an old capsule with an expired round would live on.

### 3.4 Trigger flow

Poll loop (1 s tick) over `idx_jobs_due`:

1. `status: scheduled → publishing` (atomic, crash marker).
2. Relay target resolution: load Kind 10050 of the wrap's `p` recipient from the fallback relays. Target set = 10050 relays ∪ fallback set.
   **Fallback set (decision):**
   the deployment's own relay (mandatory before launch) · `wss://relay.damus.io` · `wss://nos.lol` · `wss://relay.primal.net` · `wss://offchain.pub` · Shugur relay (time-capsule-affine). Configurable (`TOWER_FALLBACK_RELAYS`), the list is an operational, not a protocol, component.
3. Broadcast the 1059 unchanged to all target relays (retry with backoff, at least 1 OK from at least 2 relays = success; otherwise keep trying — "broadcast ≤ 60 s after publish_at" as an operational goal).
4. `status: publishing → published`, set `result_event_id`, Kind 6900 (event ID of the 1059) encrypted to the author.
5. The tower sends no reminder before the deadline and no notification beyond the Kind 6900 confirmation to the job's author in step 4. It is purely a messenger and an alarm clock: broadcast the wrap at `publish_at`, nothing else. Consequently there is no reminder escalation to reduce the practical risk of a forgotten check-in — a property of running the scheduler as specified, and something an operator or user has to mitigate on their own (e.g. with an external reminder) if they want it.

**Crash recovery:** on startup, rebroadcast all `publishing` jobs (at-least-once; double broadcast of the same 1059 is idempotent — same event ID). SQLite with WAL; every status transition in its own transaction.

### 3.5 Cancellation (Kind 5)

Kind-5 with `e` = `request_id`, author == job author → delete job + wrap (`DELETE`, no soft delete: the withholding store should not keep corpses), 7000 `success/cancelled`. Completely silent toward the recipient (delete before trigger).

---

## 4. Client flows (minimal UI, SvelteKit)

App is client-side; SSR is used only for landing/legal text. Plaintext never leaves the browser.

### 4.1 Switch state machine (client view)

```
(no switch) ──create──▶ ACTIVE ──deadline reached──▶ TRIGGERED (grace running)
   ACTIVE ──checkin ok──▶ ACTIVE (new anchor)
   ACTIVE ──delete──▶ (no switch, silent)
   ACTIVE ──checkin partial──▶ WARN (retry loop) ──all confirmed──▶ ACTIVE
   TRIGGERED ──1042 in grace window──▶ REVOKED_REBUILT (full 5-stage flow) ──▶ ACTIVE*
   TRIGGERED ──grace expired──▶ RELEASED (recipient can read)
```

\* with a permanent notice "concealment toward this recipient broken".

### 4.2 Create flow

1. NIP-07 login (`getPublicKey`), capture recipient npub + message + preset.
2. Recipient pre-check: load Kind 10050 of the recipient from the fallback relays; not found → warning "recipient has no DM relay list — delivery uses only the fallback set" (the recipient needs an npub and a nip44-capable signer to ever decrypt the capsule).
3. Build draft wrap (§1.5) → to server + own relays.
4. `computeSchedule(now, …)` → `createCapsule` → `buildJobRequest` → to tower npub.
5. Only once 7000 `success/scheduled` arrives: show the switch as ACTIVE locally + server-side. Timeout 30 s → error state, nothing counts as created.

### 4.3 Check-in flow (5 stages) with success rule

1. Sign 1042, gift-wrap it, send to **all** registered towers.
2. Decrypt draft wrap (`readDraftWrap`).
3. Set new anchor: `lastCheckinAt = created_at` of the 1042 → `computeSchedule`.
4. Rebuild capsule (`renewCapsule`; if editing, rebuild the draft wrap first).
5. Per tower: Kind-5 cancellation of the old job + new 5905 job; wait for 7000 `success/scheduled`.

**Success rule (applies from the first tower onward):** the check-in counts as successful only once stage 5 is confirmed via 7000 by **all** towers. The client persists the flow state (localStorage) as a journal `{checkin_event, per_tower: {sent, confirmed}}`:

- Partial success / abort → state WARN, banner "check-in incomplete", automatic retry (backoff 30 s / 2 min / 10 min, then manual) — retry repeats **only** stage 5 with the already-built capsule (the journal holds the finished wrap; no new NIP-07 cycle needed).
- Rationale: a timer reset without payload renewal would publish an expired round at trigger — a zero revocation window. That is why the tower does not confirm 1042 as a reset (§3.3); only the new job counts.

### 4.4 Delete / revocation

- **Delete (before trigger):** `buildCancel` to all towers + server deletion + NIP-09 on draft wraps (best effort). Silent.
- **Revocation (grace window):** the UI action "revoke" = a normal check-in (full 5-stage flow). In addition: a NIP-09 delete request on the published 1059, **signed with the locally retained ephemeral key of the wrap** — only this key can delete the 1059 via NIP-09; an author-signed delete would publicly expose the author↔wrap link. The client therefore retains the ephemeral secret of the current wrap (`createCapsule` returns it). Status "revoked" is sent to the server (decrypt page status, §5.3); the reference tower sends no notification of the revocation to the recipient. The client UI permanently shows "concealment toward this recipient broken" with three options (change recipient / conversation / leave as is). Honestly communicate best effort: the recipient's local copy may still wait out the round.

### 4.5 Ciphertext export (`lastpub-export.json`)

```json
{
  "v": 1,
  "type": "lastpub-export",
  "exported_at": <unix>,
  "capsule": { "wrap": { /* 1059 event JSON */ }, "nevent": "<nevent1...>" },
  "job": { "request_id": "<hex>", "tower": "<pubkey>", "publish_at": <unix> },
  "draft_wrap": { /* self-wrap event JSON, optional */ },
  "drand": { "chain": "<CHAIN_HASH>", "genesis": 1692803367, "period": 3 }
}
```

Covers the threat "the scheduler never broadcasts": the author (or an heir with the file) can broadcast the 1059 themselves; the decrypt page accepts the file directly (§5.2).

---

## 5. Standalone decrypt page

Static (SvelteKit `adapter-static`), purely client-side, no backend needed. Bundles `@lastpub/core`.

### 5.1 nevent encoding

NIP-19 `nevent` of the **published gift wrap (1059)**: event ID + 2–4 relay hints (target relays of the broadcast) + `author` = **ephemeral key** of the wrap (harmless, deanonymizes no one, helps relays with lookup). No `naddr`, no `note` (relay hints are essential).

### 5.2 Inputs

1. Direct link `https://<decrypt-page-host>/#<nevent>` (however the recipient obtained it),
2. nevent input field,
3. file upload `lastpub-export.json` or raw event JSON (offline path, no relay needed).

### 5.3 Flow

1. Load the 1059 from the hint relays + fallback set (or from file).
2. NIP-07 of the **recipient**: `unwrapCapsule` (2× nip44Decrypt). No extension → clear help page (extension recommendations).
3. Round status via drand HTTP (at least 2 endpoints: `api.drand.sh`, `drand.cloudflare.com`): current round < capsule round → countdown "readable from <date/time>" (computed back from the round), no decrypt attempt.
4. Round reached → `decryptCapsule` (tlock-js verifies the beacon BLS-side against the chain key — Shugur MUST "do not trust the local clock" is thereby satisfied) → plaintext display, DOM only, no storage.
5. Revocation status: the page checks best effort whether a NIP-09 delete by the wrap author (ephemeral key) or a lastpub status event exists → banner "the author has revoked this message" (display only, does not suppress the decrypt — an honest best-effort signal only).

### 5.4 Later-click

The page guarantees nothing about relay retention: as long as the 1059 remains on relays, the link works — afterward only the file path (§5.2.3) remains viable. Recipients (or the author, or an heir) should save the nevent reference and/or the exported `lastpub-export.json` locally rather than relying on relay retention alone.

---

## 6. Open protocol questions

| # | Item | Status |
|---|---|---|
| 1 | Kind 1042 registry | Spec PR-ready in §1.3. External task: submit PR against nostr-protocol/nips (README table + spec text) before launch; monitor collision risk until merged |
| 2 | Monitor 1041 spec | Commit pinned (§0). External task: check diff against `29279fc` before launch; the interop gate test (§2.3) is the technical safeguard. Feedback/PR to Shugur if needed |

**Risks:**

- **1041 = single-vendor draft:** interop secured only with the Shugur ecosystem; the kind number could officially be assigned differently. Countermeasure: pinning + gate test + own standardization push alongside the 1042 PR.
- **5905 registry doc old/inconsistent** (result 6900, NIP-04, no time parameter, no cancellation): lastpub fully documents its conventions in §1.4 — any third-party tower can implement them, which keeps any compliant 5905 scheduler interoperable.
- **tlock-js bus factor 1:** v0.9.0 audited and stable; exit strategy Go `tlock` (drand reference) for the tower should the JS lib die — the age-v1 format is interoperable.

---

## 7. Implementation steps

1. **Repo setup** (`lastpub` monorepo: `packages/core`, `packages/tower`, `apps/web`, `apps/decrypt`, `docs/protocol.md` = §1 of this document; AGPL-3.0).
2. **`@lastpub/core`** per §2 including test plan §2.3 — first working unit, purely test-driven.
3. **Reference tower** per §3 (job acceptance → 1042 → trigger → cancellation, in this order), integration test client↔tower over a local relay (e.g. strfry or nostr-rs-relay in Docker).
4. **Web app** per §4 (create → check-in → delete/revocation), then **decrypt page** per §5.
5. **External tasks in parallel:** 1042 NIPs PR (§6), Shugur diff check + interop gate (§6), operate the deployment's own relay.

---

## Sources

- Shugur Time Capsules (Kind 1041): https://github.com/Shugur-Network/NIP-XX_Time-Capsules (Commit `29279fc`)
- Kind Registry: https://github.com/nostr-protocol/nips/blob/master/README.md
- DVM Kind 5905: https://github.com/nostr-protocol/data-vending-machines/blob/master/kinds/5905.md (Commit `8391535`) · NIP-90: https://github.com/nostr-protocol/nips/blob/master/90.md
- NIP-44: https://github.com/nostr-protocol/nips/blob/master/44.md · NIP-59: …/59.md · NIP-17: …/17.md (incl. Kind 10050)
- tlock-js: https://github.com/drand/tlock-js · Go-tlock: https://github.com/drand/tlock
- drand quicknet: https://docs.drand.love/blog/2023/10/16/quicknet-is-live/ · Spec: https://docs.drand.love/docs/specification/
- nostr-tools: https://www.npmjs.com/package/nostr-tools
