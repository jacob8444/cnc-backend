import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { MessageHandler } from '../ws/MessageHandler'
import { GrblAdapter } from '../serial/GrblAdapter'
import { MachineStateStore } from '../state/MachineStateStore'

const FIRMWARE = { type: 'grbl' as const, version: '1.1h' }
const FILES_DIR = path.join(os.tmpdir(), 'cnc-test-files')

// ── Minimal stubs ────────────────────────────────────────────────────────────

function makeStubs() {
  const written:  string[] = []
  const bytes:    Buffer[] = []
  const adapter = new GrblAdapter(FIRMWARE, (d) => written.push(d), (b) => bytes.push(b))

  const streamer = {
    load:        vi.fn(),
    start:       vi.fn(),
    pause:       vi.fn(),
    resume:      vi.fn(),
    cancel:      vi.fn(),
    state:       'idle' as const,
    totalLines:  0,
  }

  const store = new MachineStateStore()

  const broadcasts: unknown[] = []
  const wsServer = {
    broadcast: vi.fn((msg) => broadcasts.push(msg)),
    sendTo:    vi.fn(),
  }

  const handler = new MessageHandler(
    // SerialManager is only used via the adapter, so a minimal stub suffices
    {} as never,
    streamer as never,
    store,
    FILES_DIR,
    wsServer as never,
    () => adapter,
  )

  return { adapter, streamer, store, wsServer, broadcasts, written, bytes, handler }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MessageHandler', () => {
  beforeEach(() => {
    fs.mkdirSync(FILES_DIR, { recursive: true })
    // Clean up any leftover test files
    for (const f of fs.readdirSync(FILES_DIR)) {
      fs.unlinkSync(path.join(FILES_DIR, f))
    }
  })

  describe('validation', () => {
    it('silently ignores messages with unknown type', () => {
      const { handler } = makeStubs()
      expect(() => handler.handle({} as never, { type: 'explode' })).not.toThrow()
    })

    it('silently ignores non-object messages', () => {
      const { handler } = makeStubs()
      expect(() => handler.handle({} as never, 'bad input')).not.toThrow()
      expect(() => handler.handle({} as never, null)).not.toThrow()
      expect(() => handler.handle({} as never, 42)).not.toThrow()
    })

    it('silently ignores command exceeding max length', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'command', data: { cmd: 'G' + '0'.repeat(300) } })
      expect(written).toHaveLength(0)
    })
  })

  describe('command', () => {
    it('sends the command via adapter.sendLine', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'command', data: { cmd: 'G28' } })
      expect(written).toContain('G28\n')
    })

    it('broadcasts the command to the console feed', () => {
      const { handler, broadcasts } = makeStubs()
      handler.handle({} as never, { type: 'command', data: { cmd: 'M3 S8000' } })
      expect(broadcasts).toContainEqual({ type: 'console', data: { line: 'M3 S8000', dir: 'tx' } })
    })
  })

  describe('jog', () => {
    it('calls adapter.jog with correct arguments', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'jog', data: { axis: 'X', dist: 10, feed: 500 } })
      expect(written[0]).toBe('$J=G91 G21 X10.0000 F500\n')
    })

    it('rejects invalid axis', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'jog', data: { axis: 'W', dist: 10, feed: 500 } })
      expect(written).toHaveLength(0)
    })

    it('rejects feed out of range', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'jog', data: { axis: 'X', dist: 10, feed: 99999 } })
      expect(written).toHaveLength(0)
    })
  })

  describe('stream', () => {
    it('broadcasts FILE_NOT_FOUND error when file is missing', () => {
      const { handler, broadcasts } = makeStubs()
      handler.handle({} as never, { type: 'stream', data: { filename: 'missing.nc' } })
      expect(broadcasts).toContainEqual({
        type: 'error',
        data: expect.objectContaining({ code: 'FILE_NOT_FOUND' }),
      })
    })

    it('loads and starts the streamer when file exists', () => {
      const { handler, streamer } = makeStubs()
      const filepath = path.join(FILES_DIR, 'test.nc')
      fs.writeFileSync(filepath, 'G0 X0\nG1 Y10\n')

      handler.handle({} as never, { type: 'stream', data: { filename: 'test.nc' } })

      expect(streamer.load).toHaveBeenCalledWith('G0 X0\nG1 Y10\n')
      expect(streamer.start).toHaveBeenCalledOnce()
    })

    it('blocks path traversal attempts', () => {
      const { handler, streamer } = makeStubs()
      // ../../etc/passwd → basename → 'passwd', won't exist in FILES_DIR
      handler.handle({} as never, { type: 'stream', data: { filename: '../../etc/passwd' } })
      expect(streamer.load).not.toHaveBeenCalled()
    })
  })

  describe('machine control', () => {
    it('pause sends feed hold and pauses streamer', () => {
      const { handler, written, streamer } = makeStubs()
      handler.handle({} as never, { type: 'pause' })
      expect(written).toContain('!')
      expect(streamer.pause).toHaveBeenCalledOnce()
    })

    it('resume sends cycle start and resumes streamer', () => {
      const { handler, written, streamer } = makeStubs()
      handler.handle({} as never, { type: 'resume' })
      expect(written).toContain('~')
      expect(streamer.resume).toHaveBeenCalledOnce()
    })

    it('cancel cancels streamer and sends soft reset', () => {
      const { handler, written, streamer } = makeStubs()
      vi.useFakeTimers()
      handler.handle({} as never, { type: 'cancel' })
      vi.runAllTimers()
      vi.useRealTimers()
      expect(streamer.cancel).toHaveBeenCalledOnce()
      expect(written).toContain('\x18')
    })

    it('unlock writes $X', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'unlock' })
      expect(written).toContain('$X\n')
    })

    it('home writes $H', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'home' })
      expect(written).toContain('$H\n')
    })

    it('reset cancels streamer and sends soft reset', () => {
      const { handler, written, streamer } = makeStubs()
      handler.handle({} as never, { type: 'reset' })
      expect(streamer.cancel).toHaveBeenCalledOnce()
      expect(written).toContain('\x18')
    })
  })

  describe('overrides', () => {
    it('feedOverride passes current value from store to adapter', () => {
      const { handler, bytes, store } = makeStubs()
      store.update({ feedOverride: 100 })
      handler.handle({} as never, { type: 'feedOverride', data: { value: 110 } })
      // +10 from 100 → one FEED_PLUS10 byte (0x91)
      expect(bytes).toContainEqual(Buffer.from([0x91]))
    })

    it('rapidOverride sends correct byte for 50%', () => {
      const { handler, bytes } = makeStubs()
      handler.handle({} as never, { type: 'rapidOverride', data: { value: 50 } })
      expect(bytes).toContainEqual(Buffer.from([0x96]))
    })

    it('rejects invalid rapidOverride value', () => {
      const { handler, bytes } = makeStubs()
      handler.handle({} as never, { type: 'rapidOverride', data: { value: 75 } })
      expect(bytes).toHaveLength(0)
    })
  })

  describe('zero', () => {
    it('sends G10 L20 for single axis', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'zero', data: { axis: 'x', wcs: 'G54' } })
      expect(written).toContain('G10 L20 P1 X0\n')
    })

    it('sends G10 L20 for all axes', () => {
      const { handler, written } = makeStubs()
      handler.handle({} as never, { type: 'zero', data: { axis: 'all', wcs: 'G55' } })
      expect(written).toContain('G10 L20 P2 X0 Y0 Z0\n')
    })
  })

  describe('getFiles', () => {
    it('broadcasts list of G-code files', () => {
      const { handler, broadcasts } = makeStubs()
      fs.writeFileSync(path.join(FILES_DIR, 'a.nc'), '')
      fs.writeFileSync(path.join(FILES_DIR, 'b.gcode'), '')
      fs.writeFileSync(path.join(FILES_DIR, 'readme.txt'), '') // filtered out

      handler.handle({} as never, { type: 'getFiles' })

      const msg = broadcasts.find((m: any) => m.type === 'files') as any
      expect(msg).toBeDefined()
      expect(msg.data).toContain('a.nc')
      expect(msg.data).toContain('b.gcode')
      expect(msg.data).not.toContain('readme.txt')
    })
  })
})
