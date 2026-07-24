import { describe, expect, it } from 'vitest'
import { compileComputation, ComputationGraphExecutor } from '@endge/core'

import { QuickJSComputationVM } from '../worker/QuickJSComputationVM'

describe('QuickJSComputationVM', () => {
  it('executes transpiled TypeScript with the shared pure API', async () => {
    const vm = new QuickJSComputationVM()
    await expect(vm.execute({
      computationIdentity: 'demo',
      outputName: 'state',
      moduleKey: 'state-v1',
      source: `function(inputs: { values: number[] }, api: any) {
        return {
          total: api.sumBy(inputs.values, value => value * 2),
          tone: api.when(api.gt(inputs.values.length, 2), 'success', 'muted'),
        }
      }`,
      inputs: { values: [1, 2, 3] },
    })).resolves.toEqual({ total: 12, tone: 'success' })
  }, 10_000)

  it('interrupts runaway code and rejects non-JSON results', async () => {
    const vm = new QuickJSComputationVM({ executionTimeoutMs: 20 })
    await expect(vm.execute({
      computationIdentity: 'demo',
      outputName: 'loop',
      moduleKey: 'loop-v1',
      source: 'function() { while (true) {} }',
      inputs: {},
    })).rejects.toThrow()

    await expect(vm.execute({
      computationIdentity: 'demo',
      outputName: 'invalid',
      moduleKey: 'invalid-v1',
      source: 'function() { return undefined }',
      inputs: {},
    })).rejects.toThrow('JSON-compatible')
  }, 10_000)

  it('executes the acceptance Endge to TypeScript to Endge graph', async () => {
    const compiled = compileComputation({
      input: null,
      output: null,
      source: `defineComputation({
        outputs: {
          base: 5,
          doubled: typescript({
            inputs: { value: output('base') },
            compute({ value }) { return value * 2 },
          }),
          result: {
            value: output('doubled'),
            tone: when(gt(output('doubled'), 5), 'success', 'muted'),
          },
        },
        result: output('result'),
      })`,
    })
    const vm = new QuickJSComputationVM()
    const executor = new ComputationGraphExecutor(() => ({
      execute: request => vm.execute(request),
    }))

    await expect(executor.run(compiled.payload, {}, 'acceptance')).resolves.toEqual({
      value: 10,
      tone: 'success',
    })
  }, 10_000)
})
