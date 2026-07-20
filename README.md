# lastpub — publish after silence

trustless · nostr-native · self-sovereign

A dead man's switch on nostr. Stay silent longer than the interval you set, and your
message gets published — encrypted, readable only by its recipient. Until then you alone
can read, edit, or revoke it.

**Four guarantees**

1. **Read:** only the author, and the recipient once the drand round is reached.
2. **Forge:** nobody — the capsule is pre-signed and sealed.
3. **Open early:** nobody — time-lock encryption against drand quicknet.
4. **Conceal:** the recipient stays hidden until the switch triggers.

## How it works

You seal a message into a capsule that cannot be opened before a chosen drand round, and
hand it to a scheduler ("tower") that withholds it until your deadline passes. Every
check-in renews the deadline and re-seals the message against a later round. Miss the
deadline and the tower broadcasts the capsule — still unreadable, because its round has
not arrived yet. That gap between trigger and round is your window to revoke.

Plaintext never leaves the browser, and the tower never learns who the recipient is. It
holds no keys: it is a messenger and an alarm clock.

Two parameters control everything. **Interval** is how often you must check in;
**grace** is the revocation window after a trigger. Presets are 7 days / 3 days,
30 days / 5 days, and 90 days / 7 days.

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
| `packages/tower` | reference scheduler (5905 jobs, withholding store, 1042 check-ins, trigger broadcast) |
| `apps/web` | minimal UI (create, check-in, revoke, export) |
| `apps/decrypt` | standalone decrypt page (nevent + export file, static) |
| `docs/` | the protocol specification |

## Notes

One switch and one message per npub. Recipients need an npub and a nip44-capable NIP-07
extension. There is no reminder service — nothing warns you before a deadline, so keep
short check-in rhythms or build your own reminders. After a false trigger, concealment
toward that recipient is permanently broken; the app says so rather than pretending
otherwise.

## Standards

Kind 1041 time capsules (Shugur draft) · kind 1042 check-in · NIP-44 v2 · NIP-59 ·
kind 5905 DVM · kind 10050 · tlock/drand quicknet.

## License

AGPL-3.0-only
