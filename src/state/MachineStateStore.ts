import { EventEmitter } from 'events'
import { defaultMachineState } from '../types'
import type { MachineState } from '../types'

export class MachineStateStore extends EventEmitter {
  private _state: MachineState = defaultMachineState()

  get state(): Readonly<MachineState> { return this._state }

  update(patch: Partial<MachineState>) {
    this._state = { ...this._state, ...patch }
    this.emit('change', this._state)
  }

  updateJob(patch: Partial<MachineState['job']>) {
    this._state = { ...this._state, job: { ...this._state.job, ...patch } }
    this.emit('change', this._state)
  }

  reset() {
    this._state = defaultMachineState()
    this.emit('change', this._state)
  }
}
