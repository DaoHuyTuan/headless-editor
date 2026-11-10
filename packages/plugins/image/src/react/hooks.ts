import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { NodeViewPropsOf } from '@penline/core'
import { usePluginState } from '@penline/react'
import { image } from '../index'

/** The props of an image node view. */
export type ImageProps = NodeViewPropsOf<typeof image>

const MIN_WIDTH = 32
/** The container the core renders a node view into. */
const NODE_VIEW_SELECTOR = '[data-penline-node-view]'

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface ImageStateApi {
  /** Whether the image is node-selected. */
  selected: boolean
  /** Whether the image is waiting for its upload. */
  uploading: boolean
}

/**
 * The selection and upload state of an image node view. `uploading` is read from the plugin state
 * with `usePluginState`, so the view re-renders when an upload starts or ends.
 * @experimental Level 4 customization API; may change after M3 without a deprecation cycle.
 */
export function useImageState(props: ImageProps): ImageStateApi {
  const st = usePluginState(props.editor, image)
  return { selected: props.selected, uploading: st?.pending.has(props.node.id) === true }
}

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface ImageAltInputProps {
  'data-editor-ignore': ''
  'aria-label': string
  value: string
  onFocus(e: FocusEvent<HTMLInputElement>): void
  onChange(e: ChangeEvent<HTMLInputElement>): void
  onBlur(e: FocusEvent<HTMLInputElement>): void
  onKeyDown(e: KeyboardEvent<HTMLInputElement>): void
}

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface ImageAltDraftApi {
  /** The text in the input: the alt, or the uncommitted draft being typed. */
  draft: string
  /** Props for an `<input>` editing the alt (`data-editor-ignore` included: the editor leaves it alone). */
  inputProps: ImageAltInputProps
}

/**
 * The alt text of an image as a local draft: committed (one undo step) on blur or Enter, reverted on
 * Escape. Outside changes (undo, redo, another view) replace the draft unless the input is focused.
 * @experimental Level 4 customization API; may change after M3 without a deprecation cycle.
 */
export function useAltDraft(props: ImageProps): ImageAltDraftApi {
  const { alt } = props.node.data
  const { updateData } = props
  const [draft, setDraft] = useState(alt)
  const draftRef = useRef(alt)
  const committedRef = useRef(alt)
  const focusedRef = useRef(false)
  /** Set only by user input; a clean draft never overwrites the model. */
  const dirtyRef = useRef(false)

  useEffect(() => {
    committedRef.current = alt
    if (!focusedRef.current) {
      draftRef.current = alt
      setDraft(alt)
    }
  }, [alt])

  const changeDraft = (value: string, dirty = false) => {
    dirtyRef.current = dirty
    draftRef.current = value
    setDraft(value)
  }

  const commit = () => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const next = draftRef.current
    if (next === committedRef.current) return
    const previous = committedRef.current
    committedRef.current = next
    if (!updateData({ alt: next })) committedRef.current = previous
  }

  return {
    draft,
    inputProps: {
      'data-editor-ignore': '',
      'aria-label': 'Alt text',
      value: draft,
      onFocus: () => {
        focusedRef.current = true
      },
      onChange: (e) => changeDraft(e.target.value, true),
      onBlur: () => {
        focusedRef.current = false
        commit()
        // An outside change that arrived while focused is picked up now.
        if (draftRef.current !== committedRef.current) changeDraft(committedRef.current)
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter') {
          commit()
        } else if (e.key === 'Escape') {
          changeDraft(committedRef.current)
          e.currentTarget.blur()
        }
      },
    },
  }
}

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface ImageResizeHandleProps {
  'data-editor-ignore': ''
  /** A vertical splitter beside the picture (not focusable: there is no keyboard resize). */
  role: 'separator'
  'aria-orientation': 'vertical'
  'aria-label': string
  style: CSSProperties
  onPointerDown(e: PointerEvent<HTMLElement>): void
  onPointerMove(e: PointerEvent<HTMLElement>): void
  onPointerUp(e: PointerEvent<HTMLElement>): void
  onPointerCancel(e: PointerEvent<HTMLElement>): void
  onLostPointerCapture(e: PointerEvent<HTMLElement>): void
}

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface ImageResizeApi {
  /** The width to render: the live width while dragging, else `data.width`. */
  width: number | undefined
  /** Whether a resize drag is in progress. */
  resizing: boolean
  /**
   * Props for the resize handle element: `data-editor-ignore`, `touch-action: none`, and
   * `role="separator"` with `aria-orientation="vertical"` and `aria-label="Resize image"`.
   */
  handleProps: ImageResizeHandleProps
}

interface Drag {
  pointerId: number
  startX: number
  startWidth: number
  max: number
  width: number
}

/**
 * Drag-resizing of an image with pointer capture: a live local width while dragging, committed
 * (rounded, one undo step) on pointerup, clamped between 32px and the width of the node view's
 * container. A `pointercancel`, or a `lostpointercapture` before the pointerup (the browser or the
 * app took the capture away), ends the drag without committing: the width goes back to `data.width`.
 * The start width is measured on the `<img>` inside the node view (falling back to
 * `data.width`), so the handle needs no ref and may sit anywhere inside the view.
 * @experimental Level 4 customization API; may change after M3 without a deprecation cycle.
 */
export function useImageResize(props: ImageProps): ImageResizeApi {
  const { width } = props.node.data
  const { updateData } = props
  const dragRef = useRef<Drag | null>(null)
  const [liveWidth, setLiveWidth] = useState<number | null>(null)

  const end = (e: PointerEvent<HTMLElement>, commitWidth: boolean) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setLiveWidth(null)
    if (!commitWidth) return
    const next = Math.round(drag.width)
    if (next !== width && drag.width !== drag.startWidth) updateData({ width: next })
  }

  return {
    width: liveWidth ?? width,
    resizing: liveWidth !== null,
    handleProps: {
      'data-editor-ignore': '',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize image',
      style: { touchAction: 'none' },
      onPointerDown: (e) => {
        if (e.button !== 0) return
        const handle = e.currentTarget
        const container = handle.closest<HTMLElement>(NODE_VIEW_SELECTOR)
        const img = (container ?? handle.parentElement)?.querySelector('img')
        const startWidth = img?.getBoundingClientRect().width || width || MIN_WIDTH
        const space = (container ?? handle.parentElement?.parentElement)?.clientWidth ?? 0
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startWidth,
          max: space > 0 ? Math.max(space, MIN_WIDTH) : Infinity,
          width: startWidth,
        }
        handle.setPointerCapture?.(e.pointerId)
        e.preventDefault()
      },
      onPointerMove: (e) => {
        const drag = dragRef.current
        if (!drag || e.pointerId !== drag.pointerId) return
        drag.width = Math.min(drag.max, Math.max(MIN_WIDTH, drag.startWidth + e.clientX - drag.startX))
        setLiveWidth(drag.width)
      },
      onPointerUp: (e) => end(e, true),
      onPointerCancel: (e) => end(e, false),
      // After a pointerup the drag is already over (its own release fires this too): a no-op then.
      onLostPointerCapture: (e) => end(e, false),
    },
  }
}
