import { WebSocketServer, type WebSocket } from 'ws'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'
import type { Event } from '@lastpub/core'

/**
 * Minimal in-process Nostr relay (EVENT/REQ/CLOSE, NIP-01) for
 * integration tests and the local dev stack. Not a replacement for a
 * production relay — no persistence, no limits, no NIPs beyond this.
 */
export class MiniRelay {
  readonly events: Event[] = []
  private readonly subs = new Map<WebSocket, Map<string, Filter[]>>()

  private constructor(
    private readonly wss: WebSocketServer,
    readonly port: number,
  ) {
    wss.on('connection', (ws) => {
      this.subs.set(ws, new Map())
      ws.on('close', () => this.subs.delete(ws))
      ws.on('message', (raw) => {
        try {
          this.handle(ws, JSON.parse(String(raw)))
        } catch {
          // malformed frame — ignore
        }
      })
    })
  }

  static async start(port = 0): Promise<MiniRelay> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve)
      wss.once('error', reject)
    })
    const addr = wss.address()
    if (addr === null || typeof addr === 'string') throw new Error('no server address')
    return new MiniRelay(wss, addr.port)
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`
  }

  private handle(ws: WebSocket, msg: unknown[]): void {
    const [type] = msg
    if (type === 'EVENT') {
      const event = msg[1] as Event
      if (!verifyEvent(event)) {
        ws.send(JSON.stringify(['OK', event?.id ?? '', false, 'invalid: bad signature']))
        return
      }
      if (!this.events.some((e) => e.id === event.id)) this.events.push(event)
      ws.send(JSON.stringify(['OK', event.id, true, '']))
      for (const [client, clientSubs] of this.subs) {
        for (const [subId, filters] of clientSubs) {
          if (matchFilters(filters, event)) {
            client.send(JSON.stringify(['EVENT', subId, event]))
          }
        }
      }
    } else if (type === 'REQ') {
      const subId = msg[1] as string
      const filters = msg.slice(2) as Filter[]
      this.subs.get(ws)?.set(subId, filters)
      for (const e of this.events) {
        if (matchFilters(filters, e)) ws.send(JSON.stringify(['EVENT', subId, e]))
      }
      ws.send(JSON.stringify(['EOSE', subId]))
    } else if (type === 'CLOSE') {
      this.subs.get(ws)?.delete(msg[1] as string)
    }
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }
}
