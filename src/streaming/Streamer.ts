import { EventEmitter } from 'events'
import { logger } from '../logger'

// GRBL and FluidNC both use a 127-byte serial RX buffer.
// We track how many bytes are currently in the controller's buffer
// and only send the next line when there's room. This is the
// character-counting method — the fastest safe streaming approach.
const GRBL_RX_BUFFER = 127

export type StreamerState = 'idle' | 'running' | 'paused' | 'complete' | 'error'

export class Streamer extends EventEmitter {
  private lines: string[]       = []
  private sentSizes: number[]   = []   // byte count of each in-flight line
  private inFlight              = 0    // bytes currently in controller buffer
  private cursor                = 0    // index of next line to send
  private _state: StreamerState = 'idle'

  get state(): StreamerState { return this._state }
  get totalLines(): number   { return this.lines.length }
  get linesSent(): number    { return this.cursor }
  get percent(): number {
    return this.lines.length === 0 ? 0 : Math.round((this.cursor / this.lines.length) * 100)
  }

  constructor(private readonly write: (line: string) => void) { super() }

  load(gcode: string): void {
    this.lines = cleanGcode(gcode)
    this.sentSizes = []
    this.inFlight  = 0
    this.cursor    = 0
    this._state    = 'idle'
    logger.info({ lines: this.lines.length }, 'G-code loaded into streamer')
  }

  start(): void {
    if (this._state !== 'idle') return
    this.setState('running')
    this.pump()
  }

  pause(): void {
    if (this._state !== 'running') return
    this.setState('paused')
    // Stop sending new lines, but keep processing 'ok' responses to
    // stay in sync with the controller buffer. Caller sends '!' to halt motion.
  }

  resume(): void {
    if (this._state !== 'paused') return
    this.setState('running')
    this.pump()
    // Caller sends '~' to resume motion.
  }

  cancel(): void {
    this.lines     = []
    this.sentSizes = []
    this.inFlight  = 0
    this.cursor    = 0
    this.setState('idle')
    // Caller sends '\x18' (soft reset) then '$X\n' (unlock).
  }

  // Called by main.ts for every 'ok' or 'error:N' the controller sends.
  // Must be called even during pause so the inFlight count stays correct.
  onResponse(line: string): void {
    if (this._state === 'idle' || this._state === 'complete') return

    // Pop the oldest in-flight line's byte count
    const size = this.sentSizes.shift()
    if (size !== undefined) this.inFlight -= size

    if (line.startsWith('error:')) {
      const code = parseInt(line.split(':')[1] ?? '0')
      const lineIndex = this.cursor - this.sentSizes.length - 1
      logger.error({ code, lineIndex }, 'Controller returned error during stream')
      this.setState('error')
      this.emit('error', { code, lineIndex })
      return
    }

    // Emit progress after each ok
    this.emit('progress', {
      percent:    this.percent,
      linesSent:  this.cursor,
      totalLines: this.lines.length,
    })

    if (this._state === 'running') this.pump()
  }

  private pump(): void {
    while (this._state === 'running' && this.cursor < this.lines.length) {
      const line = this.lines[this.cursor]!
      const size = line.length + 1  // +1 for '\n'

      if (this.inFlight + size > GRBL_RX_BUFFER) break  // buffer full

      this.write(line + '\n')
      this.inFlight += size
      this.sentSizes.push(size)
      this.cursor++
    }

    if (this.cursor >= this.lines.length && this.sentSizes.length === 0) {
      this.setState('complete')
      this.emit('complete')
      logger.info('Streaming complete')
    }
  }

  private setState(s: StreamerState) {
    this._state = s
    this.emit('stateChange', s)
  }
}

function cleanGcode(raw: string): string[] {
  return raw
    .split('\n')
    .map(line =>
      line
        .replace(/\(.*?\)/g, '')   // strip ( ) comments
        .replace(/;.*$/,    '')    // strip ; comments
        .trim()
        .toUpperCase()
    )
    .filter(Boolean)
}
