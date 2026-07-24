# lastpub — publish after silence

trustless · nostr-native · self-sovereign

A dead man's switch on nostr. Stay silent longer than the interval you set, and your
message gets published — encrypted, readable only by its recipient. Until then you alone
can read, edit, or delete it. You can stop it any time before the deadline; after the
deadline it is final.

**Four guarantees**

1. **Read:** only the author, and the recipient once the drand round is reached — which
   is exactly when the switch triggers.
2. **Forge:** nobody — the capsule is pre-signed and sealed.
3. **Open early:** nobody — time-lock encryption against drand quicknet.
4. **Conceal:** the recipient stays hidden until the switch triggers.

## How it works

You seal a message into a capsule that cannot be opened before a chosen drand round, and
hand it to a scheduler ("tower") that withholds it until your deadline passes. Every
check-in renews the deadline and re-seals the message against a later round. Miss the
deadline and the tower broadcasts the capsule — and it is readable at that same moment,
because the round is chosen to be the one reached at the deadline. There is no gap
between publication and readability, so there is no window to stop it after the fact:
you can stop a switch any time before the deadline, by deleting it; once the deadline
passes, the message is out and cannot be recalled.

Plaintext never leaves the browser, and the tower never learns who the recipient is. It
holds no keys: it is a messenger and an alarm clock.

One parameter controls everything: **interval**, how often you must check in. Presets
are 7 days, 30 days (default), and 90 days.

## Install

Requires Node 20+ and an npm with workspace support.

```sh
git clone https://github.com/satoshidude/lastpub.io.git
cd lastpub.io
npm install
npm run build
npm test
```

### Run it locally

Start a mini relay and a reference tower with a persistent key:

```sh
npm run dev-stack
```

It prints the relay URL and the tower npub. Then start the web app:

```sh
npm run dev -w @lastpub/web
```

Open it, enter that relay URL and tower npub in the settings panel, and sign in with a
nip44-capable NIP-07 extension such as Alby or nos2x. The standalone decrypt page runs
the same way:

```sh
npm run dev -w @lastpub/decrypt
```

Integration tests against the live drand quicknet need network access:

```sh
LASTPUB_INTEGRATION=1 npm test -w @lastpub/core
```

## Layout

| Path | Contents |
|---|---|
| `packages/core` | protocol and crypto library (create → renew → verify → unwrap → decrypt) |
| `packages/client` | client flows (create, check-in, delete, export) — framework-agnostic, pluggable storage |
| `packages/tower` | reference scheduler (5905 jobs, withholding store, 1042 check-ins, trigger broadcast) |
| `apps/web` | minimal UI (create, check-in, delete, export) |
| `apps/decrypt` | standalone decrypt page (nevent + export file, static) |
| `docs/` | the protocol specification |

## Notes

One switch and one message per npub. Recipients need an npub and a nip44-capable NIP-07
extension. There is no reminder service — nothing warns you before a deadline, so keep
short check-in rhythms or build your own reminders. The only protection against a
missed check-in is checking in on time; once the deadline passes, concealment toward
that recipient is permanently and immediately broken, whether the trigger was intended
or not — the app says so rather than pretending otherwise.

Switch state lives in the browser, but it is not the only copy: your drafts and the
scheduled job (which embeds the capsule) are published to the relays, and the export file
is a self-contained snapshot. On a new device or after clearing storage, sign in and
**restore from relay** (just your nsec and the relays) or **import an export file** to
rebuild the switch and resume check-ins. A check-in renews at the tower in your
settings, so if the host that ran your tower disappears, point settings at a live tower —
your own (`npm run dev-stack`) or any other — and check in to migrate; nothing but you
and the relays is required. The standalone decrypt page reads a message from its nevent
or export file alone, so a recipient never depends on this app or any single host.

The switch rests on one tower, and that is a deliberate trade, not an oversight. A tower
outage fails closed — a tower that is down never broadcasts, so the message stays concealed;
it never publishes early. The capsule is not trapped inside the tower either: it rides on the
relays inside the scheduled job, so while you are alive a lost tower is recoverable (migrate,
or restore). The one case nothing recovers from is the overlap that matters most — you are gone
*and* the tower dies before the deadline — because no one is left to migrate it. So run your
tower on durable infrastructure that is not tied to a domain or bill that may lapse, and keep
the export file as a copy an heir can broadcast. Confidentiality-preserving redundancy
(threshold keepers, not duplicate towers) is a future direction, not shipped today.

## Standards

Kind 1041 time capsules (Shugur draft) · kind 1042 check-in · NIP-44 v2 · NIP-59 ·
kind 5905 DVM · kind 10050 · tlock/drand quicknet.

## License

AGPL-3.0-only
