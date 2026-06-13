import type { FirmwareInfo, GrblState, MachineState, Vec3 } from '../types'

// Real-time command bytes (no newline, sent immediately)
const RT = {
  FEED_HOLD:      '!',
  CYCLE_START:    '~',
  SOFT_RESET:     '\x18',
  STATUS_POLL:    '?',
  JOG_CANCEL:     '\x85',
  // Feed overrides
  FEED_RESET:     Buffer.from([0x90]),
  FEED_PLUS10:    Buffer.from([0x91]),
  FEED_MINUS10:   Buffer.from([0x92]),
  FEED_PLUS1:     Buffer.from([0x93]),
  FEED_MINUS1:    Buffer.from([0x94]),
  // Rapid overrides
  RAPID_FULL:     Buffer.from([0x95]),
  RAPID_HALF:     Buffer.from([0x96]),
  RAPID_QUARTER:  Buffer.from([0x97]),
  // Spindle overrides
  SPINDLE_RESET:  Buffer.from([0x99]),
  SPINDLE_PLUS10: Buffer.from([0x9A]),
  SPINDLE_MINUS10:Buffer.from([0x9B]),
  SPINDLE_PLUS1:  Buffer.from([0x9C]),
  SPINDLE_MINUS1: Buffer.from([0x9D]),
}

export abstract class BaseAdapter {
  protected lastWco: Vec3 = { x: 0, y: 0, z: 0 }

  constructor(
    readonly firmware: FirmwareInfo,
    protected readonly write:      (data: string)  => void,
    protected readonly writeBytes: (data: Buffer)   => void,
  ) {}

  // ── Public commands ──────────────────────────────────────────────────────

  feedHold()    { this.write(RT.FEED_HOLD) }
  cycleStart()  { this.write(RT.CYCLE_START) }
  softReset()   { this.write(RT.SOFT_RESET) }
  statusPoll()  { this.write(RT.STATUS_POLL) }
  jogCancel()   { this.write(RT.JOG_CANCEL) }
  unlock()      { this.write('$X\n') }
  home()        { this.write('$H\n') }

  sendLine(cmd: string) {
    this.write(cmd.trimEnd() + '\n')
  }

  jog(axis: string, dist: number, feed: number) {
    // $J= uses G91 (relative), G21 (mm). GRBL cancels on 0x85.
    this.write(`$J=G91 G21 ${axis.toUpperCase()}${dist.toFixed(4)} F${Math.round(feed)}\n`)
  }

  zeroAxis(axis: 'x' | 'y' | 'z' | 'all', wcs: string) {
    // G10 L20 sets current position as zero in the given WCS
    const p = { G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6 }[wcs] ?? 1
    if (axis === 'all') {
      this.write(`G10 L20 P${p} X0 Y0 Z0\n`)
    } else {
      this.write(`G10 L20 P${p} ${axis.toUpperCase()}0\n`)
    }
  }

  setFeedOverride(targetPct: number, currentPct: number) {
    this.applyOverride(targetPct, currentPct, {
      reset: RT.FEED_RESET,
      plus10: RT.FEED_PLUS10, minus10: RT.FEED_MINUS10,
      plus1:  RT.FEED_PLUS1,  minus1:  RT.FEED_MINUS1,
    })
  }

  setSpindleOverride(targetPct: number, currentPct: number) {
    this.applyOverride(targetPct, currentPct, {
      reset: RT.SPINDLE_RESET,
      plus10: RT.SPINDLE_PLUS10, minus10: RT.SPINDLE_MINUS10,
      plus1:  RT.SPINDLE_PLUS1,  minus1:  RT.SPINDLE_MINUS1,
    })
  }

  setRapidOverride(targetPct: 25 | 50 | 100) {
    const byte = targetPct === 25 ? RT.RAPID_QUARTER : targetPct === 50 ? RT.RAPID_HALF : RT.RAPID_FULL
    this.writeBytes(byte)
  }

  // ── Line parser ──────────────────────────────────────────────────────────

  // Returns a partial MachineState patch if the line contains parseable data.
  // Returns null for 'ok', 'error:X', and unknown lines (caller handles those).
  parseLine(line: string): Partial<MachineState> | null {
    if (line.startsWith('<') && line.endsWith('>')) return this.parseStatus(line)
    if (line.startsWith('ALARM:'))   return this.parseAlarmLine(line)
    if (line.startsWith('[MSG:'))    return null  // info messages, ignore
    if (line.startsWith('[GC:'))     return null  // parser state, ignore for now
    return null
  }

  // ── Status report parser ─────────────────────────────────────────────────

  // Parses the full GRBL 1.1 status report format:
  // <State|MPos:x,y,z|FS:f,s|Ov:fo,ro,so|Bf:p,r|WCO:x,y,z|Pn:flags>
  protected parseStatus(line: string): Partial<MachineState> {
    const inner = line.slice(1, -1)  // strip < >
    const parts = inner.split('|')
    const patch: Partial<MachineState> = {}

    // State (first field, may include sub-state like "Hold:0")
    const stateStr = parts[0]
    patch.state = stateStr.split(':')[0] as GrblState

    for (const part of parts.slice(1)) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      const key = part.slice(0, colon)
      const val = part.slice(colon + 1)

      switch (key) {
        case 'MPos': {
          const mpos = parseVec3(val)
          patch.mpos = mpos
          // Compute WPos from cached WCO
          patch.wpos = {
            x: mpos.x - this.lastWco.x,
            y: mpos.y - this.lastWco.y,
            z: mpos.z - this.lastWco.z,
          }
          break
        }
        case 'WPos': {
          patch.wpos = parseVec3(val)
          break
        }
        case 'WCO': {
          const wco = parseVec3(val)
          this.lastWco = wco
          patch.wco = wco
          break
        }
        case 'FS': {
          const [f, s] = val.split(',').map(Number)
          patch.feed    = f ?? 0
          patch.spindle = s ?? 0
          break
        }
        case 'F': {
          patch.feed = Number(val)
          break
        }
        case 'Ov': {
          const [fo, ro, so] = val.split(',').map(Number)
          patch.feedOverride    = fo ?? 100
          patch.rapidOverride   = ro ?? 100
          patch.spindleOverride = so ?? 100
          break
        }
        case 'Bf': {
          const [planner, rx] = val.split(',').map(Number)
          patch.buffer = { planner: planner ?? 0, rx: rx ?? 0 }
          break
        }
        case 'Pn': {
          patch.pins = {
            limitX: val.includes('X'),
            limitY: val.includes('Y'),
            limitZ: val.includes('Z'),
            probe:  val.includes('P'),
          }
          break
        }
      }
    }

    return patch
  }

  private parseAlarmLine(line: string): Partial<MachineState> {
    return { state: 'Alarm' }
  }

  // ── Override helper ──────────────────────────────────────────────────────

  private applyOverride(
    target: number,
    current: number,
    bytes: { reset: Buffer; plus10: Buffer; minus10: Buffer; plus1: Buffer; minus1: Buffer }
  ) {
    if (target === 100) { this.writeBytes(bytes.reset); return }

    let delta = target - current
    // Coarse ±10%
    while (delta >= 10)  { this.writeBytes(bytes.plus10);  delta -= 10 }
    while (delta <= -10) { this.writeBytes(bytes.minus10); delta += 10 }
    // Fine ±1%
    while (delta > 0)    { this.writeBytes(bytes.plus1);   delta-- }
    while (delta < 0)    { this.writeBytes(bytes.minus1);  delta++ }
  }
}

function parseVec3(s: string): Vec3 {
  const [x, y, z] = s.split(',').map(Number)
  return { x: x ?? 0, y: y ?? 0, z: z ?? 0 }
}
