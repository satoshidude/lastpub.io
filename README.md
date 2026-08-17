![lastpub — publish after silence](docs/assets/lastpub-banner.png)

# lastpub — publish after silence

lastpub is a dead man's switch built on Nostr. If no check-in occurs within
the chosen interval, a tower publishes the encrypted message. It becomes
readable only at the release time and only by its intended recipient.

## Features

- End-to-end encryption with NIP-44
- Time-locked release via drand quicknet
- Create, renew, and delete a switch
- Restore from relays or an export file
- Browser-based state; plaintext never leaves the device
- Configurable, self-hostable tower and Nostr relays
- Separate static decryption page for recipients

## Install

Requires Node.js 20+ and npm with workspace support.

```sh
git clone https://github.com/satoshidude/lastpub.io.git
cd lastpub.io
npm install
npm run build
npm test
```

Start a local relay and tower:

```sh
npm run dev-stack
npm run dev -w @lastpub/web
```

## License

AGPL-3.0-only

## Warning

> **This project is under active development and cannot yet be relied upon for
> the secure or timely release of important data.**
