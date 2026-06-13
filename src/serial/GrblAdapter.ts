import { BaseAdapter } from './BaseAdapter'
import type { FirmwareInfo, MachineState } from '../types'

export class GrblAdapter extends BaseAdapter {
  constructor(
    firmware: FirmwareInfo,
    write: (data: string) => void,
    writeBytes: (data: Buffer) => void,
  ) {
    super(firmware, write, writeBytes)
  }

  parseLine(line: string): Partial<MachineState> | null {
    return super.parseLine(line)
  }
}
