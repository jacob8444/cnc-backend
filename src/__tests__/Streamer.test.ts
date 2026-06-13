import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Streamer } from '../streaming/Streamer'

// A long line that fills almost the entire 127-byte controller buffer.
// 'G1 X' (4) + 119 × '1' = 123 chars + '\n' = 124 bytes in flight.
// Leaves only 3 bytes free — not enough for another line.
const BIG_LINE = 'G1 X' + '1'.repeat(119)

describe('Streamer', () => {
  let written: string[]
  let streamer: Streamer

  beforeEach(() => {
    written = []
    streamer = new Streamer((line) => written.push(line))
  })

  // ── load ────────────────────────────────────────────────────────────────

  describe('load', () => {
    it('strips inline ; comments', () => {
      streamer.load('G0 X10 ; rapid move')
      expect(streamer.totalLines).toBe(1)
      streamer.start()
      expect(written[0]).toBe('G0 X10\n')
    })

    it('strips ( ) block comments', () => {
      streamer.load('G1 X10 (feed move)\nG0 Z5')
      expect(streamer.totalLines).toBe(2)
      streamer.start()
      expect(written[0]).toBe('G1 X10\n')
    })

    it('removes lines that are entirely a comment', () => {
      streamer.load('(preamble)\nG0 X0\n(end)')
      expect(streamer.totalLines).toBe(1)
    })

    it('removes blank lines', () => {
      streamer.load('\n\nG0 X0\n\n')
      expect(streamer.totalLines).toBe(1)
    })

    it('uppercases all commands', () => {
      streamer.load('g0 x10 y20')
      streamer.start()
      expect(written[0]).toBe('G0 X10 Y20\n')
    })

    it('resets state from a previous run', () => {
      streamer.load('G0 X0')
      streamer.start()
      streamer.onResponse('ok')
      expect(streamer.state).toBe('complete')

      streamer.load('G0 Y0')
      expect(streamer.state).toBe('idle')
      expect(streamer.linesSent).toBe(0)
      expect(streamer.percent).toBe(0)
    })
  })

  // ── start / pumping ──────────────────────────────────────────────────────

  describe('start', () => {
    it('transitions from idle to running', () => {
      streamer.load('G0 X0')
      expect(streamer.state).toBe('idle')
      streamer.start()
      expect(streamer.state).toBe('running')
    })

    it('sends lines immediately when they fit in the buffer', () => {
      streamer.load('G0 X0\nG1 Y10\nG0 Z5')
      streamer.start()
      // All three short lines fit well within 127 bytes
      expect(written).toHaveLength(3)
    })

    it('holds back lines that would overflow the 127-byte buffer', () => {
      streamer.load(`${BIG_LINE}\nG0 X0`)
      streamer.start()
      // BIG_LINE = 124 bytes; 'G0 X0\n' = 6 bytes; 124 + 6 = 130 > 127
      expect(written).toHaveLength(1)
      expect(written[0]).toBe(BIG_LINE + '\n')
    })

    it('never puts more than 127 bytes in flight across multiple lines', () => {
      // 12-byte lines — 10 of them = 120 bytes max in a single batch
      const line = 'G1 X0000000'  // 11 chars + \n = 12 bytes
      streamer.load(Array(20).fill(line).join('\n'))
      streamer.start()

      const totalBytes = written.reduce((sum, l) => sum + l.length, 0)
      expect(totalBytes).toBeLessThanOrEqual(127)
    })

    it('does nothing if called twice without a reload', () => {
      streamer.load('G0 X0')
      streamer.start()
      const sentAfterFirst = written.length
      streamer.start()  // should be no-op (already running)
      expect(written.length).toBe(sentAfterFirst)
    })
  })

  // ── onResponse ───────────────────────────────────────────────────────────

  describe('onResponse', () => {
    it("frees buffer space on 'ok' and sends the next held line", () => {
      streamer.load(`${BIG_LINE}\nG0 X0`)
      streamer.start()
      expect(written).toHaveLength(1)

      streamer.onResponse('ok')
      expect(written).toHaveLength(2)
      expect(written[1]).toBe('G0 X0\n')
    })

    it("emits 'complete' when all lines have been acknowledged", () => {
      const onComplete = vi.fn()
      streamer.on('complete', onComplete)

      streamer.load('G0 X0\nG1 Y5')
      streamer.start()
      streamer.onResponse('ok')
      streamer.onResponse('ok')

      expect(onComplete).toHaveBeenCalledOnce()
      expect(streamer.state).toBe('complete')
      expect(streamer.percent).toBe(100)
    })

    it("emits 'error' with the correct GRBL code and line index", () => {
      const onError = vi.fn()
      streamer.on('error', onError)

      streamer.load('G0 X0\nG1 Y5\nG0 Z1')
      streamer.start()
      streamer.onResponse('ok')     // line 0 ok
      streamer.onResponse('error:2') // line 1 fails

      expect(onError).toHaveBeenCalledWith({ code: 2, lineIndex: 1 })
      expect(streamer.state).toBe('error')
    })

    it('emits progress events with correct values', () => {
      const onProgress = vi.fn()
      streamer.on('progress', onProgress)

      streamer.load('G0 X0\nG1 Y5\nG0 Z1')
      streamer.start()
      streamer.onResponse('ok')

      expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
        totalLines: 3,
      }))
    })

    it('ignores responses when idle', () => {
      const onComplete = vi.fn()
      streamer.on('complete', onComplete)
      streamer.onResponse('ok')  // no job loaded
      expect(onComplete).not.toHaveBeenCalled()
    })
  })

  // ── pause / resume ───────────────────────────────────────────────────────

  describe('pause / resume', () => {
    it('stops pumping new lines on pause', () => {
      streamer.load(`${BIG_LINE}\nG0 X0`)
      streamer.start()
      expect(written).toHaveLength(1)

      streamer.pause()
      streamer.onResponse('ok')  // buffer freed, but paused
      expect(written).toHaveLength(1)
      expect(streamer.state).toBe('paused')
    })

    it('continues processing ok responses while paused (keeps buffer count in sync)', () => {
      // If we didn't process ok while paused, inFlight would de-sync
      // and we'd never be able to resume correctly.
      streamer.load(`${BIG_LINE}\nG0 X0\nG0 Y0`)
      streamer.start()         // sends BIG_LINE
      streamer.pause()
      streamer.onResponse('ok') // acks BIG_LINE while paused
      // inFlight should now be 0, ready to resume
      streamer.resume()
      expect(written).toHaveLength(3)  // G0 X0 and G0 Y0 now sent
    })

    it('resumes from the correct position', () => {
      streamer.load(`${BIG_LINE}\nG0 X99`)
      streamer.start()
      streamer.pause()
      streamer.onResponse('ok')
      streamer.resume()
      expect(written[1]).toBe('G0 X99\n')
    })

    it('emits stateChange events', () => {
      const states: string[] = []
      streamer.on('stateChange', (s) => states.push(s))

      streamer.load('G0 X0')
      streamer.start()
      streamer.pause()
      streamer.resume()

      expect(states).toEqual(['running', 'paused', 'running'])
    })
  })

  // ── cancel ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('resets all counters and state', () => {
      streamer.load('G0 X0\nG1 Y5')
      streamer.start()
      streamer.cancel()

      expect(streamer.state).toBe('idle')
      expect(streamer.totalLines).toBe(0)
      expect(streamer.linesSent).toBe(0)
      expect(streamer.percent).toBe(0)
    })

    it('ignores further ok responses after cancel', () => {
      const onComplete = vi.fn()
      streamer.on('complete', onComplete)

      streamer.load('G0 X0')
      streamer.start()
      streamer.cancel()
      streamer.onResponse('ok')

      expect(onComplete).not.toHaveBeenCalled()
    })

    it('can load and start a new job after cancel', () => {
      streamer.load('G0 X0')
      streamer.start()
      streamer.cancel()

      streamer.load('G0 Y0')
      streamer.start()
      expect(streamer.state).toBe('running')
      expect(written.at(-1)).toBe('G0 Y0\n')
    })
  })
})
