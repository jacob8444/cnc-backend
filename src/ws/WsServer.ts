import { EventEmitter } from 'events'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'http'
import { logger } from '../logger'
import type { ServerMessage } from '../types'

export class WsServer extends EventEmitter {
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()

  /**
   * Attach the WebSocket server to an existing HTTP server so both share
   * one port. Auth token is checked on the HTTP upgrade handshake.
   */
  constructor(
    server: Server,
    private readonly authToken?: string,
  ) {
    super()

    this.wss = new WebSocketServer({
      server,
      // Validate auth token on upgrade handshake (before WS is established)
      verifyClient: ({ req }: { req: IncomingMessage }, cb: (result: boolean, code?: number, message?: string) => void) => {
        if (!this.authToken) return cb(true)
        const url = new URL(req.url ?? '/', `http://localhost`)
        const token = url.searchParams.get('token')
          ?? req.headers['x-auth-token'] as string | undefined
        if (token === this.authToken) return cb(true)
        logger.warn({ ip: req.socket.remoteAddress }, 'WS auth failed')
        cb(false, 401, 'Unauthorized')
      },
    })

    this.wss.on('connection', (ws, req) => {
      this.clients.add(ws)
      const ip = req.socket.remoteAddress
      logger.info({ ip, total: this.clients.size }, 'WS client connected')
      this.emit('connection', ws)

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          this.emit('message', ws, msg)
        } catch {
          logger.warn('Received non-JSON WS message, ignoring')
        }
      })

      ws.on('close', () => {
        this.clients.delete(ws)
        logger.info({ ip, total: this.clients.size }, 'WS client disconnected')
      })

      ws.on('error', (err) => {
        logger.error({ err, ip }, 'WS client error')
        this.clients.delete(ws)
      })
    })

    this.wss.on('error', (err) => logger.error({ err }, 'WS server error'))
  }

  broadcast(msg: ServerMessage): void {
    const json = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json)
      }
    }
  }

  sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  get clientCount(): number { return this.clients.size }

  close(): Promise<void> {
    return new Promise((res, rej) => this.wss.close(err => err ? rej(err) : res()))
  }
}
