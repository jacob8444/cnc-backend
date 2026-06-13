import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MachineStateStore } from '../state/MachineStateStore'
import { defaultMachineState } from '../types'

describe('MachineStateStore', () => {
  let store: MachineStateStore

  beforeEach(() => {
    store = new MachineStateStore()
  })

  it('initialises to defaultMachineState', () => {
    expect(store.state).toEqual(defaultMachineState())
  })

  describe('update', () => {
    it('patches top-level scalar fields', () => {
      store.update({ connected: true, feed: 600 })
      expect(store.state.connected).toBe(true)
      expect(store.state.feed).toBe(600)
    })

    it('does not mutate unrelated fields', () => {
      const before = store.state.mpos
      store.update({ feed: 600 })
      expect(store.state.mpos).toBe(before)
    })

    it('patches nested objects with full replacement', () => {
      store.update({ mpos: { x: 10, y: 20, z: -5 } })
      expect(store.state.mpos).toEqual({ x: 10, y: 20, z: -5 })
    })

    it('emits change event with new state', () => {
      const listener = vi.fn()
      store.on('change', listener)
      store.update({ feed: 300 })
      expect(listener).toHaveBeenCalledOnce()
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ feed: 300 }))
    })

    it('does not share mutable state with previous snapshots', () => {
      const snapshot1 = store.state
      store.update({ feed: 999 })
      expect(snapshot1.feed).toBe(0)  // original untouched
      expect(store.state.feed).toBe(999)
    })
  })

  describe('updateJob', () => {
    it('patches only job fields', () => {
      store.updateJob({ state: 'running', filename: 'part.nc' })
      expect(store.state.job.state).toBe('running')
      expect(store.state.job.filename).toBe('part.nc')
      expect(store.state.job.percent).toBe(0)  // untouched
    })

    it('emits change event', () => {
      const listener = vi.fn()
      store.on('change', listener)
      store.updateJob({ percent: 50 })
      expect(listener).toHaveBeenCalledOnce()
    })

    it('does not overwrite top-level state', () => {
      store.update({ feed: 500 })
      store.updateJob({ percent: 25 })
      expect(store.state.feed).toBe(500)
    })
  })

  describe('reset', () => {
    it('returns to default state', () => {
      store.update({ connected: true, feed: 600 })
      store.updateJob({ state: 'running', percent: 40 })
      store.reset()
      expect(store.state).toEqual(defaultMachineState())
    })

    it('emits change event', () => {
      const listener = vi.fn()
      store.on('change', listener)
      store.reset()
      expect(listener).toHaveBeenCalledOnce()
    })
  })
})
