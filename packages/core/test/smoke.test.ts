import { expect, test } from 'vitest'
import * as core from '../src/index'

test('core module loads', () => {
  expect(core).toBeTypeOf('object')
})
