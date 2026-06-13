import { EventEmitter } from 'events'
import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'
import { logger } from '../logger'
import { config } from '../config'

export class SerialManager extends EventEmitter {
  private port: SerialPort | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _isOpen = false

  get isOpen() { return this._isOpen }

  constructor(
    private readonly device: string,
    private readonly baud: number,
  ) { super() }

  async open(): Promise<void> {
    if (this.port?.isOpen) return

    this.port = new SerialPort({
      path: this.device,
      baudRate: this.baud,
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,  // GRBL/FluidNC don't use hardware flow control
    })

    const parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }))

    parser.on('data', (line: string) => {
      const trimmed = line.trim()
      if (trimmed) this.emit('line', trimmed)
    })

    this.port.on('close', () => {
      this._isOpen = false
      logger.warn('Serial port closed')
      this.emit('disconnected')
      this.scheduleReconnect()
    })

    this.port.on('error', (err: Error) => {
      logger.error({ err }, 'Serial port error')
      this.emit('error', err)
      if (!this._isOpen) this.scheduleReconnect()
    })

    await new Promise<void>((res, rej) => {
      this.port!.open(err => {
        if (err) return rej(err)
        res()
      })
    })

    this._isOpen = true
    logger.info({ device: this.device, baud: this.baud }, 'Serial port opened')
    this.emit('connected')
  }

  write(data: string): void {
    if (!this.port?.isOpen) {
      logger.warn('Write attempted on closed port, ignoring')
      return
    }
    this.port.write(data, 'ascii', err => {
      if (err) logger.error({ err }, 'Serial write error')
    })
  }

  // Write raw bytes (for real-time override commands)
  writeBytes(bytes: Buffer): void {
    if (!this.port?.isOpen) return
    this.port.write(bytes, err => {
      if (err) logger.error({ err }, 'Serial write error')
    })
  }

  async close(): Promise<void> {
    this.cancelReconnect()
    if (!this.port?.isOpen) return
    await new Promise<void>(res => this.port!.close(() => res()))
    this._isOpen = false
  }

  private scheduleReconnect(delayMs = config.reconnectDelay) {
    if (this.reconnectTimer) return
    logger.info({ delayMs }, 'Scheduling reconnect…')
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.open()
      } catch (err) {
        logger.warn({ err }, 'Reconnect failed, retrying…')
        this.scheduleReconnect(Math.min(delayMs * 1.5, 30_000))
      }
    }, delayMs)
  }

  private cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
