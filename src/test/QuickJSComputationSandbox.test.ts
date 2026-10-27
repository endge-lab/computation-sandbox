import type { ComputationSandboxRequest } from '@endge/core'
import type { SandboxBatchRequest, SandboxBatchResponse } from '../worker/computation-sandbox.protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QuickJSComputationSandbox } from '../QuickJSComputationSandbox'

/** Управляемый Worker проверяет внешний протокол пула без запуска браузера. */
class TestWorker {
  static instances: TestWorker[] = []
  onmessage: ((event: MessageEvent<SandboxBatchResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn<(message: SandboxBatchRequest) => void>()
  terminate = vi.fn()

  constructor() {
    TestWorker.instances.push(this)
  }

  /** Отправляет ответ, включая запоздалый ответ уже остановленного Worker. */
  respond(results: SandboxBatchResponse['results']): void {
    this.onmessage?.({ data: { type: 'execute-batch-result', results } } as MessageEvent<SandboxBatchResponse>)
  }
}

const request: ComputationSandboxRequest = {
  computationIdentity: 'test',
  outputName: 'value',
  moduleKey: 'test-value',
  source: 'function() { return 1 }',
  inputs: {},
}
let sandbox: QuickJSComputationSandbox | undefined

beforeEach(() => {
  vi.useFakeTimers()
  TestWorker.instances = []
  vi.stubGlobal('Worker', TestWorker)
})

afterEach(() => {
  sandbox?.dispose()
  sandbox = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('жизненный цикл пула Computation Worker', () => {
  it('пакетирует вызовы одного такта и сопоставляет результаты по ID', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 1 })
    const first = sandbox.execute(request)
    const second = sandbox.execute(request)
    await Promise.resolve()
    const worker = TestWorker.instances[0]!
    const batch = worker.postMessage.mock.calls[0]![0]
    expect(batch.requests).toHaveLength(2)
    worker.respond([{ id: batch.requests[1]!.id, ok: true, value: 2 }, { id: batch.requests[0]!.id, ok: true, value: 1 }])
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
  })

  it('распределяет запросы между Workers без повторного выполнения', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 2 })
    const results = Promise.all([sandbox.execute(request), sandbox.execute(request), sandbox.execute(request)])
    await Promise.resolve()
    expect(TestWorker.instances.map(worker => worker.postMessage.mock.calls[0]![0].requests.length)).toEqual([2, 1])
    for (const worker of TestWorker.instances) {
      worker.respond(worker.postMessage.mock.calls[0]![0].requests.map(({ id }) => ({ id, ok: true, value: id })))
    }
    await expect(results).resolves.toEqual([1, 2, 3])
  })

  it('отклоняет ошибочный и отсутствующий результат и продолжает очередь', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 1 })
    const first = expect(sandbox.execute(request)).rejects.toThrow('compute failed')
    const second = expect(sandbox.execute(request)).rejects.toThrow('no result')
    await Promise.resolve()
    const worker = TestWorker.instances[0]!
    const third = sandbox.execute(request)
    await Promise.resolve()
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    worker.respond([{ id: 1, ok: false, message: 'compute failed' }])
    expect(worker.postMessage).toHaveBeenCalledTimes(2)
    worker.respond([{ id: 3, ok: true, value: 'next' }])
    await Promise.all([first, second])
    await expect(third).resolves.toBe('next')
  })

  it('заменяет зависший Worker и исполняет следующий запрос', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 1, watchdogMs: 50 })
    const failure = expect(sandbox.execute(request)).rejects.toThrow('watchdog')
    await Promise.resolve()
    const retired = TestWorker.instances[0]!
    const next = sandbox.execute(request)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)
    await failure
    expect(retired.terminate).toHaveBeenCalledOnce()
    TestWorker.instances[1]!.respond([{ id: 2, ok: true, value: 'recovered' }])
    await expect(next).resolves.toBe('recovered')
  })

  it('не позволяет запоздалым сообщению и ошибке старого Worker отменить watchdog нового', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 1, watchdogMs: 50 })
    const first = expect(sandbox.execute(request)).rejects.toThrow('watchdog')
    await Promise.resolve()
    const retired = TestWorker.instances[0]!
    const second = expect(sandbox.execute(request)).rejects.toThrow('watchdog')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)
    await first
    retired.respond([{ id: 1, ok: true, value: 'late' }])
    retired.onerror?.({ message: 'late worker error' } as ErrorEvent)
    await vi.advanceTimersByTimeAsync(50)
    await second
    expect(TestWorker.instances[1]!.terminate).toHaveBeenCalledOnce()
  })

  it('восстанавливает очередь после ошибки Worker', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 1 })
    const failure = expect(sandbox.execute(request)).rejects.toThrow('worker crashed')
    await Promise.resolve()
    const next = sandbox.execute(request)
    await Promise.resolve()
    TestWorker.instances[0]!.onerror?.({ message: 'worker crashed' } as ErrorEvent)
    TestWorker.instances[1]!.respond([{ id: 2, ok: true, value: 42 }])
    await failure
    await expect(next).resolves.toBe(42)
  })

  it('завершает запрос при синхронной ошибке отправки и восстанавливает Worker', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 1 })
    TestWorker.instances[0]!.postMessage.mockImplementationOnce(() => {
      throw new Error('clone failed')
    })
    const failed = expect(sandbox.execute(request)).rejects.toThrow('clone failed')
    await Promise.resolve()
    await failed
    const next = sandbox.execute(request)
    await Promise.resolve()
    TestWorker.instances[1]!.respond([{ id: 2, ok: true, value: 'ok' }])
    await expect(next).resolves.toBe('ok')
  })

  it('при dispose отклоняет активные и ожидающие запросы и удаляет таймеры', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 1 })
    const first = expect(sandbox.execute(request)).rejects.toThrow('disposed')
    await Promise.resolve()
    const second = expect(sandbox.execute(request)).rejects.toThrow('disposed')
    await Promise.resolve()
    sandbox.dispose()
    await Promise.all([first, second])
    expect(vi.getTimerCount()).toBe(0)
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
    await expect(sandbox.execute(request)).rejects.toThrow('disposed')
  })

  it('освобождает запрос до отправки первого пакета', async () => {
    sandbox = new QuickJSComputationSandbox({ workerCount: 1 })
    const failed = expect(sandbox.execute(request)).rejects.toThrow('disposed')
    sandbox.dispose()
    await failed
    expect(TestWorker.instances[0]!.postMessage).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('отклоняет некорректное число Workers %s до выделения ресурсов', (workerCount) => {
    expect(() => new QuickJSComputationSandbox({ workerCount })).toThrow('workerCount')
    expect(TestWorker.instances).toHaveLength(0)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('отклоняет некорректный watchdog %s до выделения ресурсов', (watchdogMs) => {
    expect(() => new QuickJSComputationSandbox({ workerCount: 1, watchdogMs })).toThrow('watchdogMs')
    expect(TestWorker.instances).toHaveLength(0)
  })
})
