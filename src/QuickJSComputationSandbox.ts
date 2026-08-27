import type { ComputationSandboxAdapter, ComputationSandboxRequest } from '@endge/core'

import type { SandboxBatchRequest, SandboxBatchResponse } from './worker/computation-sandbox.protocol'

export interface QuickJSComputationSandboxOptions {
  workerCount?: number
  watchdogMs?: number
}

interface PendingRequest {
  id: number
  request: ComputationSandboxRequest
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Batched Worker pool adapter for the core computation runtime. */
export class QuickJSComputationSandbox implements ComputationSandboxAdapter {
  private readonly _workers: WorkerSlot[]
  private readonly _queue: PendingRequest[] = []
  private _nextId = 1
  private _scheduled = false
  private _disposed = false

  constructor(options: QuickJSComputationSandboxOptions = {}) {
    const hardware = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2
    const count = options.workerCount ?? Math.min(4, Math.max(1, hardware - 1))
    const watchdogMs = options.watchdogMs ?? 500
    this._workers = Array.from({ length: count }, () => new WorkerSlot(watchdogMs))
  }

  execute(request: ComputationSandboxRequest): Promise<unknown> {
    if (this._disposed) {
      return Promise.reject(new Error('Computation sandbox is disposed.'))
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ id: this._nextId++, request, resolve, reject })
      if (!this._scheduled) {
        this._scheduled = true
        queueMicrotask(() => this._flush())
      }
    })
  }

  dispose(): void {
    this._disposed = true
    for (const item of this._queue) {
      item.reject(new Error('Computation sandbox is disposed.'))
    }
    this._queue.splice(0)
    for (const worker of this._workers) {
      worker.dispose()
    }
  }

  private _flush(): void {
    this._scheduled = false
    if (this._disposed || !this._queue.length) {
      return
    }
    const batches = Array.from({ length: this._workers.length }, () => [] as PendingRequest[])
    let index = 0
    while (this._queue.length) {
      batches[index++ % batches.length]!.push(this._queue.shift()!)
    }
    batches.forEach((batch, workerIndex) => {
      if (batch.length) {
        this._workers[workerIndex]!.execute(batch)
      }
    })
  }
}

class WorkerSlot {
  private _worker = this._createWorker()
  private readonly _queued: PendingRequest[][] = []
  private _active: PendingRequest[] | null = null
  private _timer: ReturnType<typeof setTimeout> | null = null
  private _busy = false
  private _disposed = false

  constructor(private readonly _watchdogMs: number) {}

  execute(batch: PendingRequest[]): void {
    if (this._disposed) {
      for (const item of batch) {
        item.reject(new Error('Computation Worker was disposed.'))
      }
      return
    }
    this._queued.push(batch)
    this._pump()
  }

  dispose(): void {
    this._disposed = true
    if (this._timer) {
      clearTimeout(this._timer)
    }
    this._timer = null
    this._worker.terminate()
    for (const item of this._active ?? []) {
      item.reject(new Error('Computation Worker was disposed.'))
    }
    for (const batch of this._queued) {
      for (const item of batch) {
        item.reject(new Error('Computation Worker was disposed.'))
      }
    }
    this._active = null
    this._queued.splice(0)
    this._busy = false
  }

  private _pump(): void {
    if (this._disposed || this._busy || !this._queued.length) {
      return
    }
    this._busy = true
    const batch = this._queued.shift()!
    this._active = batch
    this._timer = setTimeout(() => {
      this._worker.terminate()
      this._worker = this._createWorker()
      for (const item of batch) {
        item.reject(new Error(`Computation Worker exceeded ${this._watchdogMs} ms watchdog.`))
      }
      this._active = null
      this._timer = null
      this._busy = false
      this._pump()
    }, this._watchdogMs)

    this._worker.onmessage = (event: MessageEvent<SandboxBatchResponse>) => {
      if (this._timer) {
        clearTimeout(this._timer)
      }
      this._timer = null
      const results = new Map(event.data.results.map(result => [result.id, result]))
      for (const item of batch) {
        const result = results.get(item.id)
        if (!result) {
          item.reject(new Error('Computation Worker returned no result.'))
        }
        else if (result.ok) {
          item.resolve(result.value)
        }
        else { item.reject(new Error(result.message)) }
      }
      this._active = null
      this._busy = false
      this._pump()
    }
    this._worker.onerror = (event) => {
      if (this._timer) {
        clearTimeout(this._timer)
      }
      this._timer = null
      for (const item of batch) {
        item.reject(new Error(event.message || 'Computation Worker failed.'))
      }
      this._worker.terminate()
      this._worker = this._createWorker()
      this._active = null
      this._busy = false
      this._pump()
    }
    this._worker.postMessage({
      type: 'execute-batch',
      requests: batch.map(({ id, request }) => ({ id, request })),
    } satisfies SandboxBatchRequest)
  }

  private _createWorker(): Worker {
    return new Worker(new URL('./worker/computation-sandbox.worker.ts', import.meta.url), { type: 'module' })
  }
}

export function createQuickJSComputationSandbox(options?: QuickJSComputationSandboxOptions): QuickJSComputationSandbox {
  return new QuickJSComputationSandbox(options)
}
