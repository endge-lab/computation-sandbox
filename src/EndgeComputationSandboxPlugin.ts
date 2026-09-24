import type { EndgePlugin } from '@endge/core'
import { EndgeComputationSandbox_Module } from './modules/EndgeComputationSandbox_Module'

declare module '@endge/core' {
  interface EndgeExtensions {
    readonly computationSandbox: EndgeComputationSandbox_Module
  }
}

export const EndgeComputationSandboxPlugin: EndgePlugin = {
  id: '@endge/computation-sandbox',
  modules: [
    {
      key: 'computationSandbox',
      create: () => new EndgeComputationSandbox_Module(),
      before: 'runtime',
    },
  ],
}
