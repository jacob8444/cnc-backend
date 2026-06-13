import { BaseAdapter } from './BaseAdapter'
import type { FirmwareInfo, MachineState } from '../types'

export class FluidNCAdapter extends BaseAdapter {
  constructor(
    firmware: FirmwareInfo,
    write: (data: string) => void,
    writeBytes: (data: Buffer) => void,
  ) {
    super(firmware, write, writeBytes)
  }

  parseLine(line: string): Partial<MachineState> | null {
    // FluidNC adds optional |SD:pct,remaining| field in status reports
    if (line.startsWith('<') && line.endsWith('>')) {
      const patch = this.parseStatus(line)
      // SD card progress would be handled here if needed
      return patch
    }
    return super.parseLine(line)
  }

  // FluidNC-specific commands
  listSdFiles()  { this.write('$SD/LIST\n') }
  getConfig()    { this.write('$CD\n') }
  getFiles()     { this.write('$Files/List\n') }
}
