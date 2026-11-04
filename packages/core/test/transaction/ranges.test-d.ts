import { describe, expectTypeOf, it } from 'vitest'
import type { Range, SelectionRange } from '../../src/model/types'
import type { Fragment } from '../../src/transaction/fragment'
import type { Transaction } from '../../src/transaction/transaction'

describe('explicit ranges in a forEachRange callback', () => {
  it('addMark, removeMark and insertFragment take the callback range', () => {
    const run = (tr: Transaction, frag: Fragment) =>
      tr.forEachRange((range, t) => {
        t.addMark({ type: 'bold', data: {} }, range)
        t.removeMark('bold', range)
        t.insertFragment(frag, range)
      })
    expectTypeOf(run).toBeFunction()
  })

  it('they still take a plain Range', () => {
    const run = (tr: Transaction, frag: Fragment, r: Range) =>
      tr.addMark({ type: 'bold', data: {} }, r).removeMark('bold', r).insertFragment(frag, r)
    expectTypeOf(run).returns.toEqualTypeOf<Transaction>()
    expectTypeOf<Parameters<Transaction['addMark']>[1]>().toEqualTypeOf<SelectionRange | Range | undefined>()
  })
})
