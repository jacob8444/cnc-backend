import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GrblAdapter } from '../serial/GrblAdapter'

const FIRMWARE = { type: 'grbl' as const, version: '1.1h' }

function makeAdapter() {
  const written:  string[] = []
  const bytes:    Buffer[] = []
  const adapter = new GrblAdapter(
    FIRMWARE,
    (d) => written.push(d),
    (b) => bytes.push(b),
  )
  return { adapter, written, bytes }
}

describe('BaseAdapter — status report parsing', () => {
  let adapter: GrblAdapter

  beforeEach(() => {
    ;({ adapter } = makeAdapter())
  })

  it('parses machine state', () => {
    const p = adapter.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0>')
    expect(p?.state).toBe('Idle')
  })

  it('parses all GrblStates', () => {
    const states = ['Run', 'Hold', 'Jog', 'Alarm', 'Door', 'Check', 'Home', 'Sleep']
    for (const s of states) {
      const p = adapter.parseLine(`<${s}|MPos:0.000,0.000,0.000|FS:0,0>`)
      expect(p?.state).toBe(s)
    }
  })

  it('parses MPos', () => {
    const p = adapter.parseLine('<Run|MPos:12.345,-6.789,0.100|FS:600,8000>')
    expect(p?.mpos).toEqual({ x: 12.345, y: -6.789, z: 0.1 })
  })

  it('computes WPos from MPos using cached WCO', () => {
    // Prime the WCO cache
    adapter.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:10.000,20.000,5.000>')
    // Next status: MPos with the cached WCO applied
    const p = adapter.parseLine('<Run|MPos:15.000,25.000,5.000|FS:600,0>')
    expect(p?.wpos).toEqual({ x: 5, y: 5, z: 0 })
  })

  it('updates cached WCO when WCO field is present', () => {
    const p = adapter.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:10.000,0.000,0.000>')
    expect(p?.wco).toEqual({ x: 10, y: 0, z: 0 })
  })

  it('parses feed and spindle from FS field', () => {
    const p = adapter.parseLine('<Run|MPos:0.000,0.000,0.000|FS:1200,8000>')
    expect(p?.feed).toBe(1200)
    expect(p?.spindle).toBe(8000)
  })

  it('parses override percentages', () => {
    const p = adapter.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0|Ov:120,50,90>')
    expect(p?.feedOverride).toBe(120)
    expect(p?.rapidOverride).toBe(50)
    expect(p?.spindleOverride).toBe(90)
  })

  it('parses planner and RX buffer state', () => {
    const p = adapter.parseLine('<Run|MPos:0.000,0.000,0.000|FS:600,0|Bf:12,95>')
    expect(p?.buffer).toEqual({ planner: 12, rx: 95 })
  })

  it('parses pin flags', () => {
    const p = adapter.parseLine('<Alarm|MPos:0.000,0.000,0.000|FS:0,0|Pn:XYP>')
    expect(p?.pins).toEqual({ limitX: true, limitY: true, limitZ: false, probe: true })
  })

  it('returns null for ok', () => {
    expect(adapter.parseLine('ok')).toBeNull()
  })

  it('returns null for error lines (handled by streamer)', () => {
    expect(adapter.parseLine('error:2')).toBeNull()
  })

  it('returns Alarm state for ALARM: lines', () => {
    const p = adapter.parseLine('ALARM:1')
    expect(p?.state).toBe('Alarm')
  })

  it('returns null for unknown lines', () => {
    expect(adapter.parseLine('[MSG:Reset to continue]')).toBeNull()
    expect(adapter.parseLine('[GC:G0 G54 G17]')).toBeNull()
  })
})

describe('BaseAdapter — real-time commands', () => {
  it('feedHold writes !', () => {
    const { adapter, written } = makeAdapter()
    adapter.feedHold()
    expect(written).toContain('!')
  })

  it('cycleStart writes ~', () => {
    const { adapter, written } = makeAdapter()
    adapter.cycleStart()
    expect(written).toContain('~')
  })

  it('softReset writes 0x18', () => {
    const { adapter, written } = makeAdapter()
    adapter.softReset()
    expect(written).toContain('\x18')
  })

  it('jogCancel writes 0x85', () => {
    const { adapter, written } = makeAdapter()
    adapter.jogCancel()
    expect(written).toContain('\x85')
  })

  it('unlock writes $X\\n', () => {
    const { adapter, written } = makeAdapter()
    adapter.unlock()
    expect(written).toContain('$X\n')
  })

  it('home writes $H\\n', () => {
    const { adapter, written } = makeAdapter()
    adapter.home()
    expect(written).toContain('$H\n')
  })
})

describe('BaseAdapter — jog command', () => {
  it('builds correct $J= command for X axis', () => {
    const { adapter, written } = makeAdapter()
    adapter.jog('X', 10, 500)
    expect(written[0]).toBe('$J=G91 G21 X10.0000 F500\n')
  })

  it('builds correct $J= command for negative Z', () => {
    const { adapter, written } = makeAdapter()
    adapter.jog('Z', -2.5, 200)
    expect(written[0]).toBe('$J=G91 G21 Z-2.5000 F200\n')
  })

  it('uppercases the axis letter', () => {
    const { adapter, written } = makeAdapter()
    adapter.jog('y', 5, 300)
    expect(written[0]).toContain('Y5.0000')
  })
})

describe('BaseAdapter — zeroAxis', () => {
  it('zeros a single axis in G54 (P1)', () => {
    const { adapter, written } = makeAdapter()
    adapter.zeroAxis('x', 'G54')
    expect(written[0]).toBe('G10 L20 P1 X0\n')
  })

  it('zeros all axes in G55 (P2)', () => {
    const { adapter, written } = makeAdapter()
    adapter.zeroAxis('all', 'G55')
    expect(written[0]).toBe('G10 L20 P2 X0 Y0 Z0\n')
  })

  it('defaults to P1 for unknown WCS', () => {
    const { adapter, written } = makeAdapter()
    adapter.zeroAxis('z', 'UNKNOWN')
    expect(written[0]).toContain('P1')
  })
})

describe('BaseAdapter — overrides', () => {
  it('setFeedOverride to 100 sends reset byte 0x90', () => {
    const { adapter, bytes } = makeAdapter()
    adapter.setFeedOverride(100, 80)
    expect(bytes[0]).toEqual(Buffer.from([0x90]))
  })

  it('setFeedOverride up by 20% sends two +10% bytes', () => {
    const { adapter, bytes } = makeAdapter()
    adapter.setFeedOverride(120, 100)
    expect(bytes).toHaveLength(2)
    expect(bytes[0]).toEqual(Buffer.from([0x91]))  // +10%
    expect(bytes[1]).toEqual(Buffer.from([0x91]))  // +10%
  })

  it('setFeedOverride down by 15% sends one -10% and five -1% bytes', () => {
    const { adapter, bytes } = makeAdapter()
    adapter.setFeedOverride(85, 100)
    // -10 (coarse) + -5 × -1 (fine)
    expect(bytes).toHaveLength(6)
    expect(bytes[0]).toEqual(Buffer.from([0x92]))  // -10%
    expect(bytes[1]).toEqual(Buffer.from([0x94]))  // -1%
  })

  it('setRapidOverride half sends 0x96', () => {
    const { adapter, bytes } = makeAdapter()
    adapter.setRapidOverride(50)
    expect(bytes[0]).toEqual(Buffer.from([0x96]))
  })

  it('setRapidOverride full sends 0x95', () => {
    const { adapter, bytes } = makeAdapter()
    adapter.setRapidOverride(100)
    expect(bytes[0]).toEqual(Buffer.from([0x95]))
  })

  it('setSpindleOverride reset sends 0x99', () => {
    const { adapter, bytes } = makeAdapter()
    adapter.setSpindleOverride(100, 80)
    expect(bytes[0]).toEqual(Buffer.from([0x99]))
  })
})
