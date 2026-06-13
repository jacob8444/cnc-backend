import type { FirmwareInfo } from '../types'

// Called on every incoming serial line until firmware is identified.
// Returns null for lines that aren't a startup greeting.
export function detectFirmware(line: string): FirmwareInfo | null {
  // GRBL: "Grbl 1.1h ['$' for help]"
  const grbl = line.match(/^Grbl\s+([\d.]+[a-z]?)/i)
  if (grbl) return { type: 'grbl', version: grbl[1] }

  // FluidNC: "FluidNC v3.7.14 [ESP32]" or "FluidNC v3.7.14"
  const fluid = line.match(/^FluidNC\s+(v[\d.]+)(?:\s+\[([^\]]+)\])?/i)
  if (fluid) return { type: 'fluidnc', version: fluid[1], board: fluid[2] }

  return null
}
