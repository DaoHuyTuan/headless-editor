import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Data } from '../model/types'
import type { AnyPlugin, MarkSpec, NodeSpec } from './types'

export const DEFAULT_PRIORITY = 100

export type ValidateResult = { ok: true; data: Data } | { ok: false; message: string }
export type RegisteredNode = NodeSpec & { plugin: AnyPlugin }
export type RegisteredMark = MarkSpec<any> & { plugin: AnyPlugin } // eslint-disable-line @typescript-eslint/no-explicit-any

function isPlainObject(value: unknown): value is Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function assertSyncSchema(schema: StandardSchemaV1, pluginName: string): void {
  let result: unknown
  try {
    result = schema['~standard'].validate({})
  } catch {
    return // a sync validator that throws on `{}` is still sync
  }
  if (isThenable(result)) {
    // Swallow the probe's rejection so it never surfaces as unhandled.
    result.then(undefined, () => {})
    throw new Error(`Async validators are not supported (plugin "${pluginName}")`)
  }
}

export class Registry {
  /** Sorted by priority desc; ties keep registration order. */
  readonly plugins: AnyPlugin[]
  readonly defaultBlock: string
  private readonly byName = new Map<string, AnyPlugin>()
  private readonly nodes = new Map<string, RegisteredNode>()
  private readonly marks = new Map<string, RegisteredMark>()
  private readonly markRanks = new Map<string, number>()

  constructor(plugins: AnyPlugin[]) {
    for (const plugin of plugins) {
      if (this.byName.has(plugin.name)) throw new Error(`Duplicate plugin "${plugin.name}"`)
      this.byName.set(plugin.name, plugin)
      const { spec } = plugin
      if (spec.data) assertSyncSchema(spec.data, plugin.name)
      if (spec.node) this.nodes.set(plugin.name, { ...spec.node, plugin })
      if (spec.mark) {
        this.marks.set(plugin.name, { ...spec.mark, plugin })
        this.markRanks.set(plugin.name, this.markRanks.size)
      }
    }

    // Array.prototype.sort is stable, so ties keep registration order.
    this.plugins = [...plugins].sort(
      (a, b) => (b.spec.priority ?? DEFAULT_PRIORITY) - (a.spec.priority ?? DEFAULT_PRIORITY),
    )

    const defaultBlock = this.plugins.find((p) => p.spec.node?.kind === 'block' && p.spec.node.default)
    if (!defaultBlock) throw new Error('No default block plugin registered')
    this.defaultBlock = defaultBlock.name
  }

  node(type: string): RegisteredNode | undefined {
    return this.nodes.get(type)
  }

  mark(type: string): RegisteredMark | undefined {
    return this.marks.get(type)
  }

  /** Registration order among mark plugins; unknown marks sort last. */
  markRank(type: string): number {
    return this.markRanks.get(type) ?? Number.MAX_SAFE_INTEGER
  }

  /** Validates `raw` against the type's data schema. `undefined` is treated as `{}`. */
  validateData(type: string, raw: unknown): ValidateResult {
    const input = raw === undefined ? {} : raw
    const schema = this.byName.get(type)?.spec.data
    if (!schema) {
      return isPlainObject(input)
        ? { ok: true, data: input }
        : { ok: false, message: `Data for "${type}" must be a plain object` }
    }
    const result = schema['~standard'].validate(input)
    if (isThenable(result)) {
      return { ok: false, message: `Async validators are not supported (plugin "${type}")` }
    }
    if (result.issues) {
      return { ok: false, message: result.issues.map((i) => i.message).join('; ') || 'Invalid data' }
    }
    if (!isPlainObject(result.value)) {
      return { ok: false, message: `Data for "${type}" must validate to a plain object` }
    }
    return { ok: true, data: result.value }
  }
}
