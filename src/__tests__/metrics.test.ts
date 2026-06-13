import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'

// /proc/stat line format:
// cpu  user nice system idle iowait irq softirq ...
// CPU % = 1 - (idleDelta / totalDelta)

describe('getMetrics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns the correct shape', async () => {
    // Stub /proc/stat — two identical samples → 0% CPU
    vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
      if (String(path) === '/proc/stat')
        return 'cpu  100 0 200 700 0 0 0 0 0 0\n'
      if (String(path).includes('thermal'))
        return '52000'   // 52.0°C
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { getMetrics } = await import('../system/metrics')
    const promise = getMetrics()
    vi.advanceTimersByTime(500)
    const result = await promise

    expect(result).toMatchObject({
      cpu:      expect.any(Number),
      temp:     expect.any(Number),
      ramUsed:  expect.any(Number),
      ramTotal: expect.any(Number),
      load1:    expect.any(Number),
    })
  })

  it('calculates 50% CPU correctly', async () => {
    let call = 0
    vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
      if (String(path) === '/proc/stat') {
        call++
        // Sample 1: idle=1000, total=2000
        // Sample 2: idle=1100, total=2200
        // idleDelta=100, totalDelta=200 → CPU = 50%
        return call === 1
          ? 'cpu  600 0 400 1000 0 0 0 0 0 0\n'   // total=2000, idle=1000
          : 'cpu  700 0 400 1100 0 0 0 0 0 0\n'   // total=2200, idle=1100
      }
      if (String(path).includes('thermal')) return '55000'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { getMetrics } = await import('../system/metrics')
    vi.resetModules()
    const promise = getMetrics()
    vi.advanceTimersByTime(500)
    const result = await promise

    expect(result.cpu).toBe(50)
  })

  it('parses temperature in tenths of a degree', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
      if (String(path) === '/proc/stat')
        return 'cpu  100 0 200 700 0 0 0 0 0 0\n'
      if (String(path).includes('thermal'))
        return '72400'  // → 72.4°C
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { getMetrics } = await import('../system/metrics')
    vi.resetModules()
    const promise = getMetrics()
    vi.advanceTimersByTime(500)
    const result = await promise

    expect(result.temp).toBe(72.4)
  })

  it('returns 0 for temp when thermal file is missing', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
      if (String(path) === '/proc/stat')
        return 'cpu  100 0 200 700 0 0 0 0 0 0\n'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { getMetrics } = await import('../system/metrics')
    vi.resetModules()
    const promise = getMetrics()
    vi.advanceTimersByTime(500)
    const result = await promise

    expect(result.temp).toBe(0)
  })

  it('returns 0 for CPU when /proc/stat is missing (non-Linux)', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { getMetrics } = await import('../system/metrics')
    vi.resetModules()
    const promise = getMetrics()
    vi.advanceTimersByTime(500)
    const result = await promise

    expect(result.cpu).toBe(0)
  })
})
