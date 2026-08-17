# Security policy

lastpub is a dead man's switch: it decides whether a private message stays sealed or
becomes readable. A bug here is not a crash, it is either a message that surfaces too
early or one that never surfaces at all. Reports are welcome and taken seriously.

## Reporting a vulnerability

Please report privately, not in a public issue:

**[Open a private security advisory](https://github.com/satoshidude/lastpub.io/security/advisories/new)**

That channel is private between you and the maintainer until an advisory is published.
Include what you need to make the issue reproducible — affected component, version or
commit, and the conditions under which it triggers.

If you do not hear back within 14 days, please open a public issue saying only that you
are waiting on a security response, with no details.

## What is in scope

- **`packages/core`** — capsule construction, tlock round computation, NIP-44 v2 and
  NIP-59 layering, seal and gift-wrap handling, check-in signing and verification.
  Anything that lets a capsule be opened before its drand round, lets a message be
  forged, or leaks the recipient before the trigger.
- **`packages/tower`** — job acceptance, the withholding store, check-in replay
  protection, trigger and cancellation handling. Anything that lets a third party
  suppress, forge, or prematurely release a broadcast, or that exposes withheld
  capsules.
- **`apps/web` and `apps/decrypt`** — anything that causes plaintext or a draft to leave
  the browser, or that misreports a switch's state to its author.

## Known and accepted risks

These are properties of the design, documented in `docs/protocol-spec.md`. They are not
vulnerabilities, though a report showing one is worse than documented is very welcome:

- A scheduler that leaks a capsule before the trigger breaks concealment of the
  recipient. The content stays sealed — gift wrap plus tlock — but the fact that a
  capsule exists for that recipient can escape.
- After a false trigger, concealment toward that recipient is permanently broken. It
  cannot be undone, only disclosed, and the app discloses it.
- A scheduler that never broadcasts silently prevents delivery. There is one scheduler
  per switch; the ciphertext export exists so an author is not solely dependent on it.
- Decryption depends on drand quicknet being reachable. An outage delays reading; it
  does not affect the trigger.
- There is no reminder service. Nothing warns an author before a deadline, which makes
  a false trigger more likely than in a system that does warn.

## Out of scope

- Advisories against development dependencies (vite, vitest, esbuild, the Svelte
  compiler). None of them ship to users — `npm audit --omit=dev` reports zero.
- Findings that require an already-compromised signing key, browser extension, or
  operating system.
- Missing hardening headers on a deployment you do not control.

## Supported versions

The project is pre-1.0 and only the current `main` receives fixes.
