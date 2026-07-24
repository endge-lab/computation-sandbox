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
  private readonly workers: WorkerSlot[]
  private readonly queue: PendingRequest[] = []
  private nextId = 1
  private scheduled = false
  private disposed = false

  constructor(options: QuickJSComputationSandboxOptions = {}) {
    const hardware = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2
    const count = options.workerCount ?? Math.min(4, Math.max(1, hardware - 1))
    const watchdogMs = options.watchdogMs ?? 500
    this.workers = Array.from({ length: count }, () => new WorkerSlot(watchdogMs))
  }

  execute(request: ComputationSandboxRequest): Promise<unknown> {
    if (this.disposed)
      return Promise.reject(new Error('Computation sandbox is disposed.'))
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, request, resolve, reject })
      if (!this.scheduled) {
        this.scheduled = true
        queueMicrotask(() => this.flush())
      }
    })
  }

  dispose(): void {
    this.disposed = true
    for (const item of this.queue) item.reject(new Error('Computation sandbox is disposed.'))
    this.queue.splice(0)
    for (const worker of this.workers) worker.dispose()
  }

  private flush(): void {
    this.scheduled = false
    if (this.disposed || !this.queue.length)
      return
    const batches = Array.from({ length: this.workers.length }, () => [] as PendingRequest[])
    let index = 0
    while (this.queue.length) batches[index++ % batches.length]!.push(this.queue.shift()!)
    batches.forEach((batch, workerIndex) => {
      if (batch.length) this.workers[workerIndex]!.execute(batch)
    })
  }
}

class WorkerSlot {
  private worker = this.createWorker()
  private readonly queued: PendingRequest[][] = []
  private active: PendingRequest[] | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  private disposed = false

  constructor(private readonly watchdogMs: number) {}

  execute(batch: PendingRequest[]): void {
    if (this.disposed) {
      for (const item of batch) item.reject(new Error('Computation Worker was disposed.'))
      return
    }
    this.queued.push(batch)
    this.pump()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.worker.terminate()
    for (const item of this.active ?? []) item.reject(new Error('Computation Worker was disposed.'))
    for (const batch of this.queued) for (const item of batch) item.reject(new Error('Computation Worker was disposed.'))
    this.active = null
    this.queued.splice(0)
    this.busy = false
  }

  private pump(): void {
    if (this.disposed || this.busy || !this.queued.length)
      return
    this.busy = true
    const batch = this.queued.shift()!
    this.active = batch
    this.timer = setTimeout(() => {
      this.worker.terminate()
      this.worker = this.createWorker()
      for (const item of batch) item.reject(new Error(`Computation Worker exceeded ${this.watchdogMs} ms watchdog.`))
      this.active = null
      this.timer = null
      this.busy = false
      this.pump()
    }, this.watchdogMs)

    this.worker.onmessage = (event: MessageEvent<SandboxBatchResponse>) => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      const results = new Map(event.data.results.map(result => [result.id, result]))
      for (const item of batch) {
        const result = results.get(item.id)
        if (!result) item.reject(new Error('Computation Worker returned no result.'))
        else if (result.ok) item.resolve(result.value)
        else item.reject(new Error(result.message))
      }
      this.active = null
      this.busy = false
      this.pump()
    }
    this.worker.onerror = (event) => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      for (const item of batch) item.reject(new Error(event.message || 'Computation Worker failed.'))
      this.worker.terminate()
      this.worker = this.createWorker()
      this.active = null
      this.busy = false
      this.pump()
    }
    this.worker.postMessage({
      type: 'execute-batch',
      requests: batch.map(({ id, request }) => ({ id, request })),
    } satisfies SandboxBatchRequest)
  }

  private createWorker(): Worker {
    return new Worker(new URL('./worker/computation-sandbox.worker.ts', import.meta.url), { type: 'module' })
  }
}

export function createQuickJSComputationSandbox(options?: QuickJSComputationSandboxOptions): QuickJSComputationSandbox {
  return new QuickJSComputationSandbox(options)
}
