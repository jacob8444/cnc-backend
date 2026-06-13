// ── Shared types ──────────────────────────────────────────────────────────────

export type FirmwareType = 'grbl' | 'fluidnc'

export interface FirmwareInfo {
  type: FirmwareType
  version: string
  board?: string
}

export interface Vec3 { x: number; y: number; z: number }

export type GrblState =
  | 'Idle' | 'Run' | 'Hold' | 'Jog'
  | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep'

export interface MachineState {
  connected:  boolean
  firmware:   FirmwareInfo | null
  state:      GrblState | null
  mpos:       Vec3
  wpos:       Vec3
  wco:        Vec3
  feed:       number
  spindle:    number
  feedOverride:    number   // percent 10–200
  rapidOverride:   number   // 25 | 50 | 100
  spindleOverride: number   // percent 10–200
  pins: {
    limitX: boolean
    limitY: boolean
    limitZ: boolean
    probe:  boolean
  }
  buffer: {
    planner: number
    rx:      number
  }
  job: {
    state:      'idle' | 'running' | 'paused' | 'complete' | 'error'
    filename:   string | null
    percent:    number
    linesSent:  number
    totalLines: number
  }
}

export const defaultMachineState = (): MachineState => ({
  connected: false,
  firmware:  null,
  state:     null,
  mpos:      { x: 0, y: 0, z: 0 },
  wpos:      { x: 0, y: 0, z: 0 },
  wco:       { x: 0, y: 0, z: 0 },
  feed:      0,
  spindle:   0,
  feedOverride:    100,
  rapidOverride:   100,
  spindleOverride: 100,
  pins:   { limitX: false, limitY: false, limitZ: false, probe: false },
  buffer: { planner: 0, rx: 0 },
  job: { state: 'idle', filename: null, percent: 0, linesSent: 0, totalLines: 0 },
})

// ── WebSocket messages ─────────────────────────────────────────────────────────

export interface SysMetrics {
  cpu:      number
  temp:     number
  ramUsed:  number
  ramTotal: number
  load1:    number
}

export type ServerMessage =
  | { type: 'state';      data: MachineState }
  | { type: 'status';     data: Partial<MachineState> }
  | { type: 'console';    data: { line: string; dir: 'rx' | 'tx' } }
  | { type: 'progress';   data: { percent: number; linesSent: number; totalLines: number } }
  | { type: 'sysmetrics'; data: SysMetrics }
  | { type: 'firmware';   data: FirmwareInfo }
  | { type: 'error';      data: { code: string; message: string } }
  | { type: 'files';      data: string[] }

export type ClientMessage =
  | { type: 'command';        data: { cmd: string } }
  | { type: 'jog';            data: { axis: string; dist: number; feed: number } }
  | { type: 'stream';         data: { filename: string } }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'reset' }
  | { type: 'unlock' }
  | { type: 'home' }
  | { type: 'feedOverride';    data: { value: number } }
  | { type: 'spindleOverride'; data: { value: number } }
  | { type: 'rapidOverride';   data: { value: 25 | 50 | 100 } }
  | { type: 'zero';            data: { axis: 'x' | 'y' | 'z' | 'all'; wcs: string } }
