import type { ComputationSandboxRequest } from '@endge/core'

export interface SandboxBatchRequest {
  type: 'execute-batch'
  requests: Array<{ id: number, request: ComputationSandboxRequest }>
}

export interface SandboxBatchResponse {
  type: 'execute-batch-result'
  results: Array<
    | { id: number, ok: true, value: unknown }
    | { id: number, ok: false, message: string }
  >
}
