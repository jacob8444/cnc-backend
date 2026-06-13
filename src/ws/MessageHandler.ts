import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import type { WebSocket } from 'ws'
import { logger } from '../logger'
import type { BaseAdapter } from '../serial/BaseAdapter'
import type { SerialManager } from '../serial/SerialManager'
import type { Streamer } from '../streaming/Streamer'
import type { MachineStateStore } from '../state/MachineStateStore'
import type { WsServer } from './WsServer'

// ── Zod schemas ──────────────────────────────────────────────────────────────

const Cmd        = z.object({ type: z.literal('command'),        data: z.object({ cmd: z.string().max(256) }) })
const Jog        = z.object({ type: z.literal('jog'),            data: z.object({ axis: z.enum(['X','Y','Z']), dist: z.number(), feed: z.number().min(1).max(10000) }) })
const Stream     = z.object({ type: z.literal('stream'),         data: z.object({ filename: z.string().max(256) }) })
const FeedOvr    = z.object({ type: z.literal('feedOverride'),   data: z.object({ value: z.number().int().min(10).max(200) }) })
const SpindleOvr = z.object({ type: z.literal('spindleOverride'),data: z.object({ value: z.number().int().min(10).max(200) }) })
const RapidOvr   = z.object({ type: z.literal('rapidOverride'),  data: z.object({ value: z.union([z.literal(25), z.literal(50), z.literal(100)]) }) })
const Zero       = z.object({ type: z.literal('zero'),           data: z.object({ axis: z.enum(['x','y','z','all']), wcs: z.string().max(4) }) })
const Schema = z.discriminatedUnion('type', [
  Cmd, Jog, Stream, FeedOvr, SpindleOvr, RapidOvr, Zero,
  z.object({ type: z.literal('pause')    }),
  z.object({ type: z.literal('resume')   }),
  z.object({ type: z.literal('cancel')   }),
  z.object({ type: z.literal('reset')    }),
  z.object({ type: z.literal('unlock')   }),
  z.object({ type: z.literal('home')     }),
  z.object({ type: z.literal('getFiles') }),
])

// ── Handler ──────────────────────────────────────────────────────────────────

export class MessageHandler {
  constructor(
    private readonly serial:   SerialManager,
    private readonly streamer: Streamer,
    private readonly store:    MachineStateStore,
    private readonly filesDir: string,
    private readonly ws:       WsServer,
    private getAdapter: () => BaseAdapter | null,
  ) {}

  handle(_ws: WebSocket, raw: unknown): void {
    const result = Schema.safeParse(raw)
    if (!result.success) {
      logger.warn({ errors: result.error.issues }, 'Invalid WS message')
      return
    }

    const msg = result.data
    const adapter = this.getAdapter()

    switch (msg.type) {

      case 'command': {
        if (!adapter) return
        adapter.sendLine(msg.data.cmd)
        this.ws.broadcast({ type: 'console', data: { line: msg.data.cmd, dir: 'tx' } })
        break
      }

      case 'jog': {
        if (!adapter) return
        adapter.jog(msg.data.axis, msg.data.dist, msg.data.feed)
        break
      }

      case 'stream': {
        if (!adapter) { logger.warn('stream requested but no adapter'); return }
        const filepath = safeJoin(this.filesDir, msg.data.filename)
        if (!fs.existsSync(filepath)) {
          this.ws.broadcast({ type: 'error', data: { code: 'FILE_NOT_FOUND', message: `File not found: ${msg.data.filename}` } })
          return
        }
        const gcode = fs.readFileSync(filepath, 'utf8')
        this.streamer.load(gcode)
        this.store.updateJob({ state: 'running', filename: msg.data.filename, percent: 0, linesSent: 0, totalLines: this.streamer.totalLines })
        this.streamer.start()
        break
      }

      case 'pause':
        if (!adapter) return
        adapter.feedHold()
        this.streamer.pause()
        break

      case 'resume':
        if (!adapter) return
        adapter.cycleStart()
        this.streamer.resume()
        break

      case 'cancel':
        if (!adapter) return
        this.streamer.cancel()
        adapter.softReset()
        // Unlock after a brief delay to let reset complete
        setTimeout(() => adapter.unlock(), 500)
        break

      case 'reset':
        if (!adapter) return
        this.streamer.cancel()
        adapter.softReset()
        break

      case 'unlock':
        if (!adapter) return
        adapter.unlock()
        break

      case 'home':
        if (!adapter) return
        adapter.home()
        break

      case 'feedOverride': {
        if (!adapter) return
        const current = this.store.state.feedOverride
        adapter.setFeedOverride(msg.data.value, current)
        break
      }

      case 'spindleOverride': {
        if (!adapter) return
        const current = this.store.state.spindleOverride
        adapter.setSpindleOverride(msg.data.value, current)
        break
      }

      case 'rapidOverride':
        if (!adapter) return
        adapter.setRapidOverride(msg.data.value)
        break

      case 'zero':
        if (!adapter) return
        adapter.zeroAxis(msg.data.axis, msg.data.wcs)
        break

      case 'getFiles': {
        const files = fs.existsSync(this.filesDir)
          ? fs.readdirSync(this.filesDir).filter(f => /\.(nc|gcode|g|tap)$/i.test(f))
          : []
        this.ws.broadcast({ type: 'files', data: files })
        break
      }
    }
  }
}

function safeJoin(base: string, name: string): string {
  const resolved = path.resolve(base, path.basename(name))
  if (!resolved.startsWith(path.resolve(base))) throw new Error('Path traversal detected')
  return resolved
}
