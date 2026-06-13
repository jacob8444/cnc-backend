import fs from 'fs'
import http from 'http'
import { config } from './config'
import { logger } from './logger'
import { SerialManager } from './serial/SerialManager'
import { detectFirmware } from './serial/detect'
import { GrblAdapter } from './serial/GrblAdapter'
import { FluidNCAdapter } from './serial/FluidNCAdapter'
import { MachineStateStore } from './state/MachineStateStore'
import { Streamer } from './streaming/Streamer'
import { WsServer } from './ws/WsServer'
import { MessageHandler } from './ws/MessageHandler'
import { startMetricsLoop } from './system/metrics'
import { createApiServer } from './api/routes'
import type { BaseAdapter } from './serial/BaseAdapter'

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  logger.info({ config: { port: config.serialPort, baud: config.serialBaud, httpAndWs: config.port } }, 'CNC backend starting')

  fs.mkdirSync(config.filesDir, { recursive: true })

  // ── Core objects ──────────────────────────────────────────────────────────

  const store  = new MachineStateStore()
  const serial = new SerialManager(config.serialPort, config.serialBaud)

  // Build a single HTTP server that serves both the REST API, the built
  // frontend, and the WebSocket upgrade — all on one port.
  const apiApp    = createApiServer(config.filesDir, config.uiDir, serial, store)
  const httpServer = http.createServer(apiApp)
  const wsServer   = new WsServer(httpServer, config.authToken)

  // Streamer gets a write function pointing at the serial port
  const streamer = new Streamer((line) => serial.write(line))

  let adapter:    BaseAdapter | null = null
  let pollTimer:  ReturnType<typeof setInterval> | null = null

  // ── Adaptive status poller ────────────────────────────────────────────────

  const startPoll = () => {
    if (pollTimer) clearInterval(pollTimer)
    const interval = (store.state.state === 'Run' || store.state.state === 'Jog')
      ? config.pollIntervalRun
      : config.pollIntervalIdle
    pollTimer = setInterval(() => {
      if (adapter) serial.write('?')
    }, interval)
  }

  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  // ── Machine state → WebSocket broadcast ──────────────────────────────────

  store.on('change', (state) => {
    wsServer.broadcast({ type: 'state', data: state })
  })

  // ── Streamer events ───────────────────────────────────────────────────────

  streamer.on('progress', (prog) => {
    store.updateJob({ percent: prog.percent, linesSent: prog.linesSent, totalLines: prog.totalLines })
    wsServer.broadcast({ type: 'progress', data: prog })
  })

  streamer.on('stateChange', (jobState: string) => {
    store.updateJob({ state: jobState as 'idle' | 'running' | 'paused' | 'complete' | 'error' })
  })

  streamer.on('error', (err: { code: number; lineIndex: number }) => {
    store.updateJob({ state: 'error' })
    wsServer.broadcast({ type: 'error', data: { code: `GRBL_ERROR_${err.code}`, message: `Controller error ${err.code} at line ${err.lineIndex + 1}` } })
  })

  streamer.on('complete', () => {
    store.updateJob({ state: 'complete', percent: 100 })
    logger.info('Job complete')
  })

  // ── Serial events ─────────────────────────────────────────────────────────

  serial.on('connected', () => {
    store.update({ connected: true })
    wsServer.broadcast({ type: 'console', data: { line: `Connected: ${config.serialPort} @ ${config.serialBaud}`, dir: 'rx' } })
    logger.info('Serial connected — waiting for firmware greeting…')
  })

  serial.on('disconnected', () => {
    stopPoll()
    adapter = null
    store.reset()
    wsServer.broadcast({ type: 'console', data: { line: 'Disconnected', dir: 'rx' } })
    logger.warn('Serial disconnected')
  })

  serial.on('line', (line: string) => {
    // Always broadcast raw line to console
    wsServer.broadcast({ type: 'console', data: { line, dir: 'rx' } })

    // ── Phase 1: firmware detection (adapter not yet set) ─────────────────
    if (!adapter) {
      const fw = detectFirmware(line)
      if (!fw) return

      adapter = fw.type === 'fluidnc'
        ? new FluidNCAdapter(fw, (d) => serial.write(d), (b) => serial.writeBytes(b))
        : new GrblAdapter(fw,    (d) => serial.write(d), (b) => serial.writeBytes(b))

      store.update({ firmware: fw })
      wsServer.broadcast({ type: 'firmware', data: fw })
      logger.info({ firmware: fw }, 'Firmware detected')
      startPoll()
      return
    }

    // ── Phase 2: normal operation ─────────────────────────────────────────

    // 'ok' and 'error:N' go to the streamer first (keep buffer accounting in sync)
    if (line === 'ok' || line.startsWith('error:')) {
      streamer.onResponse(line)
      return
    }

    // Parse state updates from status reports and alarm lines
    const patch = adapter.parseLine(line)
    if (patch) {
      store.update(patch)

      // Re-tune polling interval when machine state changes
      if ('state' in patch) startPoll()
    }

    // Re-detect after a soft reset (controller re-sends startup greeting)
    if (line.startsWith('Grbl') || line.startsWith('FluidNC')) {
      const fw = detectFirmware(line)
      if (fw) {
        logger.info({ fw }, 'Controller reset — firmware re-detected')
        startPoll()
      }
    }
  })

  serial.on('error', (err: Error) => {
    logger.error({ err }, 'Serial error')
  })

  // ── WebSocket events ──────────────────────────────────────────────────────

  const handler = new MessageHandler(
    serial, streamer, store, config.filesDir, wsServer,
    () => adapter,
  )

  wsServer.on('message', (ws: import('ws').WebSocket, msg: unknown) => {
    handler.handle(ws, msg)
  })

  // Send full state snapshot to each new client
  wsServer.on('connection', (ws: import('ws').WebSocket) => {
    wsServer.sendTo(ws, { type: 'state', data: store.state })
  })

  // ── System metrics loop ───────────────────────────────────────────────────

  startMetricsLoop((metrics) => {
    wsServer.broadcast({ type: 'sysmetrics', data: metrics })
  }, 2000)

  // ── Start the shared HTTP + WebSocket server ──────────────────────────────

  await new Promise<void>(res => httpServer.listen(config.port, res))
  logger.info(`Listening on :${config.port} — UI + API + WebSocket`)

  // ── Connect serial ────────────────────────────────────────────────────────

  try {
    await serial.open()
  } catch (err) {
    logger.warn({ err, device: config.serialPort }, 'Initial serial open failed — will retry automatically')
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down…')
    stopPoll()
    if (streamer.state === 'running') streamer.cancel()
    await serial.close()
    await wsServer.close()
    httpServer.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
