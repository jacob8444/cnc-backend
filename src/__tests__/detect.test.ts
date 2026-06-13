import { describe, it, expect } from 'vitest'
import { detectFirmware } from '../serial/detect'

describe('detectFirmware', () => {
  describe('GRBL', () => {
    it('detects standard greeting', () => {
      const fw = detectFirmware("Grbl 1.1h ['$' for help]")
      expect(fw).toEqual({ type: 'grbl', version: '1.1h' })
    })

    it('detects numeric-only version', () => {
      const fw = detectFirmware('Grbl 0.9j')
      expect(fw).toEqual({ type: 'grbl', version: '0.9j' })
    })

    it('is case-insensitive', () => {
      const fw = detectFirmware('GRBL 1.1h')
      expect(fw).not.toBeNull()
      expect(fw?.type).toBe('grbl')
    })
  })

  describe('FluidNC', () => {
    it('detects greeting with board', () => {
      const fw = detectFirmware('FluidNC v3.7.14 [ESP32]')
      expect(fw).toEqual({ type: 'fluidnc', version: 'v3.7.14', board: 'ESP32' })
    })

    it('detects greeting without board field', () => {
      const fw = detectFirmware('FluidNC v3.7.14')
      expect(fw).toEqual({ type: 'fluidnc', version: 'v3.7.14', board: undefined })
    })

    it('detects ESP32-S3 board variant', () => {
      const fw = detectFirmware('FluidNC v3.7.14 [ESP32-S3]')
      expect(fw?.board).toBe('ESP32-S3')
    })
  })

  describe('non-greeting lines', () => {
    it.each([
      'ok',
      'error:2',
      'ALARM:1',
      '<Idle|MPos:0.000,0.000,0.000|FS:0,0>',
      '[MSG:Reset to continue]',
      '',
      '$$ = 0',
    ])('returns null for %s', (line) => {
      expect(detectFirmware(line)).toBeNull()
    })
  })
})
