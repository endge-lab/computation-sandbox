import type { EndgePlugin } from '@endge/core'
import { Endge, EndgeModule } from '@endge/core'

import { createQuickJSComputationSandbox } from './QuickJSComputationSandbox'

class EndgeComputationSandboxModule extends EndgeModule {
  private _adapter: ReturnType<typeof createQuickJSComputationSandbox> | null = null

  public override setup(): void {
    this._adapter = createQuickJSComputationSandbox()
    Endge.runtime.computation.setSandboxAdapter(this._adapter)
  }

  public override reset(): void {
    Endge.runtime.computation.setSandboxAdapter(null)
    this._adapter = null
  }
}

export const EndgeComputationSandboxPlugin: EndgePlugin = {
  id: '@endge/computation-sandbox',
  install(): void {
    Endge.defineModule({
      key: 'computationSandbox',
      module: new EndgeComputationSandboxModule(),
      before: 'runtime',
    })
  },
}
