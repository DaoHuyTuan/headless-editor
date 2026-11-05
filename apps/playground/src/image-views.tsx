import { createContext, useContext } from 'react'
import { safeSrc } from '@hte/image'
import { ImageView, useAltDraft, useImageResize, useImageState, type ImageProps } from '@hte/image/react'
import { dataAttrs } from '@hte/react'

export type ImageViewKind = 'default' | 'custom'

/** Which image view the playground shows (set per story by App.tsx). */
export const ImageViewKindContext = createContext<ImageViewKind>('default')

const RESIZE_CLASS = 'image-resize'
/** Utilities for the handle; the position offsets live in styles.css (they differ per view). */
const RESIZE_UTILS = 'absolute -right-1.25 size-2.5 cursor-ew-resize rounded-xs border border-white bg-blue-500'

/** The default image view (level 2: `classNames`), its resize handle classed for styles.css and the e2e tests. */
function DefaultImageView(props: ImageProps) {
  return <ImageView {...props} classNames={{ resizeHandle: `${RESIZE_CLASS} ${RESIZE_UTILS}` }} />
}

/**
 * A custom image view built from the image hooks only (level 4): own markup, a caption showing the
 * committed alt, an "uploading" badge. The hooks' props carry `data-editor-ignore`; the src goes
 * through `safeSrc`, which the hooks do not apply. Keeps the `data-hte-image` attribute contract.
 */
function HooksOnlyImageView(props: ImageProps) {
  const { selected, uploading } = useImageState(props)
  const { width, resizing, handleProps } = useImageResize(props)
  const { inputProps } = useAltDraft(props)
  const { src, alt } = props.node.data
  return (
    <figure
      className="rounded-md border border-neutral-200 bg-blue-50 p-1.5"
      data-hte-image=""
      data-custom-image="" {...dataAttrs({ selected, uploading, resizing })}>
      <img src={safeSrc(src) ?? undefined} alt={alt} width={width} draggable={false} />
      <figcaption className="text-xs text-neutral-600">
        {uploading ? <span className="mr-1.5 rounded-sm bg-amber-300 px-1">uploading…</span> : null}
        <span data-testid="custom-alt-caption">{alt === '' ? '(no alt)' : alt}</span>
      </figcaption>
      <input {...inputProps} placeholder="Describe the image" />
      <span {...handleProps} className={`${RESIZE_CLASS} ${RESIZE_UTILS}`} />
    </figure>
  )
}

/** The `nodeViews.image` of the playground: the default view, or the hooks-only one in the `customImage` story. */
export function PlaygroundImageView(props: ImageProps) {
  return useContext(ImageViewKindContext) === 'custom' ? <HooksOnlyImageView {...props} /> : <DefaultImageView {...props} />
}
