// @vitest-environment happy-dom
import type { ComponentType } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { dataAttrs, resolveParts } from '../src/index'

type PartProps = { className?: string }
const Img: ComponentType<PartProps> = ({ className }) => <img className={className} data-part="img" />
const Handle: ComponentType<PartProps> = ({ className }) => <i className={className} data-part="handle" />
const defaults = { Img, Handle }

afterEach(cleanup)

describe('resolveParts', () => {
  it('returns the defaults when there are no overrides', () => {
    const r = resolveParts(defaults, undefined)
    expect(r.Img).toBe(Img)
    expect(r.Handle).toBe(Handle)
  })

  it('hides a part set to false', () => {
    const r = resolveParts(defaults, { Handle: false })
    expect(r.Handle).toBeNull()
    expect(r.Img).toBe(Img)
  })

  it('returns a replacement as-is, which receives the className', () => {
    const Custom: ComponentType<PartProps> = ({ className }) => <b className={className} data-part="custom" />
    const Part = resolveParts(defaults, { Img: Custom }).Img!
    expect(Part).toBe(Custom)
    const { container } = render(<Part className="mine" />)
    expect(container.querySelector('[data-part="custom"]')?.className).toBe('mine')
  })
})

describe('dataAttrs', () => {
  it('drops false and undefined flags', () => {
    expect(dataAttrs({ selected: true, open: false, active: undefined })).toEqual({ 'data-selected': '' })
  })
  it('returns an empty object for no true flags', () => {
    expect(dataAttrs({})).toEqual({})
  })
})
