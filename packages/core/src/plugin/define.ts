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
 * `data` schema's output, `O` from `options`, `C` from `commands`, `S` from `state`.
 */
export function definePlugin<
  const Name extends string,
  D = Data,
  O = NoOptions,
  C extends CommandMap = NoOptions,
  S = undefined,
>(spec: PluginSpec<Name, D, O, C, S>): Plugin<PluginSpec<Name, D, O, C, S>> {
  return createPlugin(spec)
}
