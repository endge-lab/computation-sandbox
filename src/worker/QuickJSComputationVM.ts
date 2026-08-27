import type { ComputationSandboxRequest } from '@endge/core'
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core'

import ts from 'typescript'

export interface QuickJSComputationVMOptions {
  executionTimeoutMs?: number
  memoryLimitBytes?: number
  stackLimitBytes?: number
}

/** One isolated QuickJS VM factory used inside a Worker. */
export class QuickJSComputationVM {
  private readonly quickJs = newQuickJSWASMModuleFromVariant(variant)
  private readonly moduleSources = new Map<string, string>()
  private readonly executionTimeoutMs: number
  private readonly memoryLimitBytes: number
  private readonly stackLimitBytes: number

  constructor(options: QuickJSComputationVMOptions = {}) {
    this.executionTimeoutMs = options.executionTimeoutMs ?? 250
    this.memoryLimitBytes = options.memoryLimitBytes ?? 32 * 1024 * 1024
    this.stackLimitBytes = options.stackLimitBytes ?? 512 * 1024
  }

  async execute(request: ComputationSandboxRequest): Promise<unknown> {
    assertJsonCompatible(request.inputs, 'inputs')
    if (!this.moduleSources.has(request.moduleKey)) {
      this.moduleSources.set(request.moduleKey, transpileCompute(request.source))
    }

    const module = await this.quickJs
    const runtime = module.newRuntime()
    runtime.setMemoryLimit(this.memoryLimitBytes)
    runtime.setMaxStackSize(this.stackLimitBytes)
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.executionTimeoutMs))
    const context = runtime.newContext()
    try {
      const result = context.evalCode(makeProgram(this.moduleSources.get(request.moduleKey)!, request.inputs))
      if (result.error) {
        const error = context.dump(result.error)
        result.error.dispose()
        throw new Error(errorMessage(error))
      }
      const value = context.dump(result.value)
      result.value.dispose()
      assertJsonCompatible(value, 'result')
      return value
    }
    finally {
      context.dispose()
      runtime.dispose()
    }
  }
}

function transpileCompute(source: string): string {
  return ts.transpileModule(
    `const __compute = (${source});`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
        allowJs: true,
      },
    },
  ).outputText
}

function makeProgram(compiledSource: string, inputs: Record<string, unknown>): string {
  return `
    const __inputs = ${JSON.stringify(inputs)};
    const __array = value => Array.isArray(value) ? value : [];
    const __record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const __read = (value, path) => String(path ?? '').split('.').filter(Boolean)
      .reduce((current, key) => current == null ? undefined : current[key], value);
    const __has = (value, path) => String(path ?? '').split('.').filter(Boolean)
      .every((key, index, parts) => {
        const parent = parts.slice(0, index).reduce((current, part) => current == null ? undefined : current[part], value);
        return parent != null && Object.prototype.hasOwnProperty.call(Object(parent), key);
      });
    const __selector = selector => typeof selector === 'function'
      ? selector
      : value => __read(value, String(selector ?? ''));
    const __deepMerge = (target, source, defaultsOnly = false) => {
      const out = { ...__record(target) };
      for (const [key, value] of Object.entries(__record(source))) {
        if (value && typeof value === 'object' && !Array.isArray(value))
          out[key] = __deepMerge(out[key], value, defaultsOnly);
        else if (!defaultsOnly || out[key] == null)
          out[key] = value;
      }
      return out;
    };
    const __groupBy = (items, selector) => __array(items).reduce((out, item, index) => {
      const key = String(__selector(selector)(item, index));
      (out[key] ??= []).push(item);
      return out;
    }, {});
    const __keyBy = (items, selector) => Object.fromEntries(__array(items)
      .map((item, index) => [String(__selector(selector)(item, index)), item]));
    const __uniqBy = (items, selector) => {
      const seen = new Set();
      return __array(items).filter((item, index) => {
        const key = __selector(selector)(item, index);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const __extremumBy = (items, selector, direction) => __array(items).reduce((best, item, index) => {
      if (best === undefined) return item;
      return (__selector(selector)(item, index) - __selector(selector)(best, index)) * direction > 0 ? item : best;
    }, undefined);
    const __join = (left, right, leftKey, rightKey, full) => {
      const leftSelector = __selector(leftKey);
      const rightSelector = __selector(rightKey ?? leftKey);
      const matched = new Set();
      const rows = __array(left).map((leftItem, leftIndex) => {
        const index = __array(right).findIndex((rightItem, rightIndex) => leftSelector(leftItem, leftIndex) === rightSelector(rightItem, rightIndex));
        if (index >= 0) matched.add(index);
        return { left: leftItem, right: index >= 0 ? right[index] : null };
      });
      if (full) __array(right).forEach((rightItem, index) => {
        if (!matched.has(index)) rows.push({ left: null, right: rightItem });
      });
      return rows;
    };
    const api = Object.freeze({
      get: (value, path) => __read(value, path),
      getOr: (value, path, fallback) => __read(value, path) ?? fallback,
      has: (value, path) => __has(value, path),
      defaultTo: (value, fallback) => value ?? fallback,
      pick: (value, keys) => Object.fromEntries(__array(keys).filter(key => key in __record(value)).map(key => [key, value[key]])),
      omit: (value, keys) => Object.fromEntries(Object.entries(__record(value)).filter(([key]) => !__array(keys).includes(key))),
      merge: (...values) => values.reduce((out, value) => __deepMerge(out, value), {}),
      defaults: (value, ...fallbacks) => fallbacks.reduce((out, fallback) => __deepMerge(out, fallback, true), __deepMerge({}, value)),
      compact: value => __array(value).filter(Boolean),
      keys: value => Object.keys(__record(value)),
      values: value => Object.values(__record(value)),
      entries: value => Object.entries(__record(value)),
      map: (value, selector) => __array(value).map(__selector(selector)),
      where: (value, predicate) => __array(value).filter(__selector(predicate)),
      reject: (value, predicate) => __array(value).filter((item, index) => !__selector(predicate)(item, index)),
      find: (value, predicate) => __array(value).find(__selector(predicate)),
      some: (value, predicate) => __array(value).some(__selector(predicate)),
      every: (value, predicate) => __array(value).every(__selector(predicate)),
      flatMap: (value, selector) => __array(value).flatMap(__selector(selector)),
      flatten: value => __array(value).flat(),
      uniq: value => [...new Set(__array(value))],
      uniqBy: (value, selector) => __uniqBy(value, selector),
      concat: (...values) => values.flatMap(__array),
      take: (value, count = 1) => __array(value).slice(0, Math.max(0, Number(count))),
      drop: (value, count = 1) => __array(value).slice(Math.max(0, Number(count))),
      sortBy: (value, selector) => [...__array(value)].sort((left, right) => {
        const leftValue = __selector(selector)(left);
        const rightValue = __selector(selector)(right);
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      }),
      groupBy: (value, selector) => __groupBy(value, selector),
      keyBy: (value, selector) => __keyBy(value, selector),
      size: value => value == null ? 0 : (value.length ?? Object.keys(__record(value)).length),
      sum: value => __array(value).reduce((total, item) => total + Number(item || 0), 0),
      sumBy: (value, selector) => __array(value).reduce((total, item, index) => total + Number(__selector(selector)(item, index) || 0), 0),
      min: value => __array(value).length ? Math.min(...value) : undefined,
      max: value => __array(value).length ? Math.max(...value) : undefined,
      minBy: (value, selector) => __extremumBy(value, selector, -1),
      maxBy: (value, selector) => __extremumBy(value, selector, 1),
      trim: value => String(value ?? '').trim(),
      lowerCase: value => String(value ?? '').toLowerCase(),
      upperCase: value => String(value ?? '').toUpperCase(),
      split: (value, separator = '') => String(value ?? '').split(String(separator)),
      join: (value, separator = ',') => __array(value).join(String(separator)),
      match: (value, pattern) => new RegExp(pattern).test(String(value ?? '')),
      eq: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      ne: (left, right) => JSON.stringify(left) !== JSON.stringify(right),
      gt: (left, right) => left > right,
      gte: (left, right) => left >= right,
      lt: (left, right) => left < right,
      lte: (left, right) => left <= right,
      includes: (value, item) => value?.includes?.(item) ?? false,
      and: (...values) => values.every(Boolean),
      or: (...values) => values.some(Boolean),
      when: (condition, value, fallback) => condition ? value : fallback,
      not: value => !value,
      isNil: value => value == null,
      isEmpty: value => value == null || value.length === 0 || (typeof value === 'object' && Object.keys(value).length === 0),
      between: (value, min, max) => value >= min && value <= max,
      inList: (value, values) => __array(values).some(item => JSON.stringify(item) === JSON.stringify(value)),
      inArray: (value, values) => !Array.isArray(values) || values.length === 0 || values.includes(value),
      relativeDate: offset => new Date(Date.now() + Number(offset || 0) * 86400000).toISOString().slice(0, 10),
      relativeDateTime: (offset, unit = 'day') => new Date(Date.now() + Number(offset || 0) * ({ second: 1000, minute: 60000, hour: 3600000, day: 86400000 }[unit] ?? 86400000)).toISOString(),
      leftJoin: (left, right, leftKey, rightKey) => __join(left, right, leftKey, rightKey, false),
      fullJoin: (left, right, leftKey, rightKey) => __join(left, right, leftKey, rightKey, true),
      lookupOne: (source, key, targetPath = 'id', sourcePath = 'id') => __array(source).find(item => __read(item, sourcePath) === __read(key, targetPath)),
      lookupMany: (source, key, targetPath = 'id', sourcePath = 'id') => __array(source).filter(item => __read(item, sourcePath) === __read(key, targetPath)),
      enrich: (value, patch) => ({ ...__record(value), ...__record(patch) }),
      action: (identity, input) => ({ kind: 'action', identity: String(identity ?? ''), input }),
      emit: (event, payload) => ({ kind: 'emit', event: String(event ?? ''), payload }),
    });
    ${compiledSource}
    __compute(__inputs, api);
  `
}

function assertJsonCompatible(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Computation ${label} must be JSON-compatible.`)
  }
  if (seen.has(value)) {
    throw new Error(`Computation ${label} must be JSON-compatible.`)
  }
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    value.forEach(item => assertJsonCompatible(item, label, seen))
  }
  else if (prototype === Object.prototype || prototype === null) {
    Object.values(value as Record<string, unknown>).forEach(item => assertJsonCompatible(item, label, seen))
  }
  else {
    throw new Error(`Computation ${label} must be JSON-compatible.`)
  }
  seen.delete(value)
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error) {
    return String(error.message)
  }
  return String(error)
}
