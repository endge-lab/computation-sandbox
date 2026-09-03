import { Endge, EndgeModule } from '@endge/core'
import { createQuickJSComputationSandbox } from './QuickJSComputationSandbox'

/** Подключает изолированный QuickJS adapter к computation runtime на время lifecycle Endge. */
export class EndgeComputationSandbox_Module extends EndgeModule {
  /** Активный sandbox adapter текущего lifecycle. */
  private _adapter: ReturnType<typeof createQuickJSComputationSandbox> | null = null

  /**
   * ----------------------------------------
   * PUBLIC
   * ----------------------------------------
   */

  /** Создаёт и подключает sandbox adapter перед запуском runtime. */
  public override setup(): void {
    this._adapter = createQuickJSComputationSandbox()
    Endge.runtime.computation.setSandboxAdapter(this._adapter)
  }

  /** Отключает adapter и освобождает ссылку текущего lifecycle. */
  public override reset(): void {
    Endge.runtime.computation.setSandboxAdapter(null)
    this._adapter = null
  }
}
