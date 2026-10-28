import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { NodeViewProps } from '@hte/core'
import { useEditorState } from '@hte/react'
import type { ImageData, ImageOptions, ImageStorage } from './index'
import { safeSrc } from './src-policy'

const MIN_WIDTH = 32

interface Drag {
  pointerId: number
  startX: number
  startWidth: number
  max: number
  width: number
}

/** React node view of the image plugin: the picture, an alt-text input and a resize handle. */
export function ImageView({ node, selected, editor, updateData }: NodeViewProps<ImageData, ImageOptions>) {
  const { src, alt, width } = node.data
  const pending = useEditorState(editor, (_state, e) =>
    ((e.storage as Record<string, unknown>).image as ImageStorage | undefined)?.isPending(node.id) ?? false,
  )

  // Alt draft: local while typing, committed on blur / Enter.
  const [draft, setDraft] = useState(alt)
  const draftRef = useRef(alt)
  const committedRef = useRef(alt)
  const focusedRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    committedRef.current = alt
    // Follow outside changes (undo, redo, another view) unless the user is typing.
    if (!focusedRef.current) {
      draftRef.current = alt
      setDraft(alt)
    }
  }, [alt])

  const changeDraft = (value: string) => {
    draftRef.current = value
    setDraft(value)
  }

  const commit = () => {
    const next = draftRef.current
    if (next === committedRef.current) return
    const previous = committedRef.current
    committedRef.current = next
    if (!updateData({ alt: next })) committedRef.current = previous
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit()
    } else if (e.key === 'Escape') {
      changeDraft(committedRef.current)
      inputRef.current?.blur()
    }
  }

  // Resize: live local width, committed on pointerup.
  const figureRef = useRef<HTMLElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [liveWidth, setLiveWidth] = useState<number | null>(null)

  const startResize = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return
    const startWidth = imgRef.current?.getBoundingClientRect().width || width || MIN_WIDTH
    const parentWidth = figureRef.current?.parentElement?.clientWidth ?? 0
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth,
      max: parentWidth > 0 ? Math.max(parentWidth, MIN_WIDTH) : Infinity,
      width: startWidth,
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  const moveResize = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    drag.width = Math.min(drag.max, Math.max(MIN_WIDTH, drag.startWidth + e.clientX - drag.startX))
    setLiveWidth(drag.width)
  }

  const endResize = (e: PointerEvent<HTMLSpanElement>, commitWidth: boolean) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setLiveWidth(null)
    if (!commitWidth) return
    const next = Math.round(drag.width)
    if (next !== width && drag.width !== drag.startWidth) updateData({ width: next })
  }

  return (
    <figure
      ref={figureRef}
      className="hte-image"
      data-selected={selected}
      data-uploading={pending ? '' : undefined}
    >
      <img
        ref={imgRef}
        src={safeSrc(src) ?? undefined}
        alt={alt}
        width={liveWidth ?? width}
        draggable={false}
      />
      <input
        ref={inputRef}
        data-editor-ignore=""
        aria-label="Alt text"
        value={draft}
        onFocus={() => {
          focusedRef.current = true
        }}
        onChange={(e) => changeDraft(e.target.value)}
        onBlur={() => {
          focusedRef.current = false
          commit()
          // An outside change that arrived while focused is picked up now.
          if (draftRef.current !== committedRef.current) changeDraft(committedRef.current)
        }}
        onKeyDown={onKeyDown}
      />
      <span
        data-editor-ignore=""
        className="hte-image-resize"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={(e) => endResize(e, true)}
        onPointerCancel={(e) => endResize(e, false)}
      />
    </figure>
  )
}
