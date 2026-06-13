import fs from 'fs'
import os from 'os'
import type { SysMetrics } from '../types'

// Reads /proc/stat for accurate CPU usage measurement.
// Takes two samples 500 ms apart and returns the idle ratio.
interface CpuSample { idle: number; total: number }

function sampleCpu(): CpuSample {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0] ?? ''
  const vals = line.trim().split(/\s+/).slice(1).map(Number)
  // Fields: user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
  const idle  = (vals[3] ?? 0) + (vals[4] ?? 0)  // idle + iowait
  const total = vals.reduce((a, b) => a + b, 0)
  return { idle, total }
}

async function measureCpuPercent(): Promise<number> {
  try {
    const s1 = sampleCpu()
    await new Promise(r => setTimeout(r, 500))
    const s2 = sampleCpu()
    const idleDelta  = s2.idle  - s1.idle
    const totalDelta = s2.total - s1.total
    if (totalDelta === 0) return 0
    return Math.round((1 - idleDelta / totalDelta) * 100)
  } catch {
    // /proc/stat not available (non-Linux dev machine)
    return 0
  }
}

function readTempCelsius(): number {
  try {
    // Linux thermal zone — works on Raspberry Pi and most SBCs
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim()
    return Math.round(parseInt(raw) / 100) / 10  // millidegrees → degrees, 1 decimal
  } catch {
    return 0
  }
}

export async function getMetrics(): Promise<SysMetrics> {
  const [cpu, load] = await Promise.all([
    measureCpuPercent(),
    Promise.resolve(os.loadavg()),
  ])
  const totalMem = os.totalmem()
  const freeMem  = os.freemem()

  return {
    cpu,
    temp:     readTempCelsius(),
    ramUsed:  Math.round((totalMem - freeMem) / 1024 / 1024),
    ramTotal: Math.round(totalMem / 1024 / 1024),
    load1:    Math.round((load[0] ?? 0) * 100) / 100,
  }
}

// Starts a background interval that calls cb with fresh metrics.
// The interval is staggered slightly so the two 500ms CPU samples
// don't align with the WS broadcast cycle.
export function startMetricsLoop(
  cb: (metrics: SysMetrics) => void,
  intervalMs = 2000,
): () => void {
  let running = true

  const loop = async () => {
    while (running) {
      const metrics = await getMetrics()
      if (running) cb(metrics)
      // Remaining wait after the ~500ms CPU sample
      await new Promise(r => setTimeout(r, Math.max(100, intervalMs - 500)))
    }
  }

  loop().catch(() => {})
  return () => { running = false }
}
