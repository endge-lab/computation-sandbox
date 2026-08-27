/// <reference lib="webworker" />

import type { SandboxBatchRequest, SandboxBatchResponse } from './computation-sandbox.protocol'
import { QuickJSComputationVM } from './QuickJSComputationVM'

const vm = new QuickJSComputationVM()

self.onmessage = async (event: MessageEvent<SandboxBatchRequest>) => {
  if (event.data?.type !== 'execute-batch') {
    return
  }
  const results: SandboxBatchResponse['results'] = []
  for (const item of event.data.requests) {
    try {
      const value = await vm.execute(item.request)
      results.push({ id: item.id, ok: true, value })
    }
    catch (error) {
      results.push({ id: item.id, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
  self.postMessage({ type: 'execute-batch-result', results } satisfies SandboxBatchResponse)
}
