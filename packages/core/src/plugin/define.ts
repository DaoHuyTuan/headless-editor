import type { Data } from '../model/types'
import type { AnyPluginSpec, CommandMap, NoOptions, Plugin, PluginSpec } from './types'

function createPlugin<Spec extends AnyPluginSpec>(spec: Spec): Plugin<Spec> {
  return {
    name: spec.name,
    spec,
    configure(options) {
      return createPlugin({ ...spec, options: { ...spec.options, ...options } })
    },
    extend(overrides) {
      return createPlugin({ ...spec, ...overrides })
    },
  }
}

/**
 * Defines a plugin. Type parameters are inferred from the spec: `D` from the
 * `data` schema's output, `O` from `options`, `C` from `commands`, `S` from `state`, `T` from `storage`.
 */
export function definePlugin<
  const Name extends string,
  D = Data,
  O = NoOptions,
  C extends CommandMap = NoOptions,
  S = undefined,
  T = undefined,
>(spec: PluginSpec<Name, D, O, C, S, T>): Plugin<PluginSpec<Name, D, O, C, S, T>> {
  return createPlugin(spec)
}
