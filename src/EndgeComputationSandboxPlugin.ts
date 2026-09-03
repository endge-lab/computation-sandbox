import type { EndgePlugin } from '@endge/core'
import { Endge } from '@endge/core'
import { EndgeComputationSandbox_Module } from './EndgeComputationSandbox_Module'

export const EndgeComputationSandboxPlugin: EndgePlugin = {
  id: '@endge/computation-sandbox',
  install(): void {
    Endge.defineModule({
      key: 'computationSandbox',
      module: new EndgeComputationSandbox_Module(),
      before: 'runtime',
    })
  },
}
