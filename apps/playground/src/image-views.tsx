import { createContext, useContext } from 'react'
import { safeSrc } from '@hte/image'
import { ImageView, useAltDraft, useImageResize, useImageState, type ImageProps } from '@hte/image/react'
import { dataAttrs } from '@hte/react'

export type ImageViewKind = 'default' | 'custom'

/** Which image view the playground shows (set per scenario by App.tsx). */
export const ImageViewKindContext = createContext<ImageViewKind>('default')

const RESIZE_CLASS = 'image-resize'

/** The default image view (level 2: `classNames`), its resize handle classed for styles.css and the e2e tests. */
function DefaultImageView(props: ImageProps) {
  return <ImageView {...props} classNames={{ resizeHandle: RESIZE_CLASS }} />
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
    <figure data-hte-image="" data-custom-image="" {...dataAttrs({ selected, uploading, resizing })}>
      <img src={safeSrc(src) ?? undefined} alt={alt} width={width} draggable={false} />
      <figcaption>
        {uploading ? <span className="badge">uploading…</span> : null}
        <span data-testid="custom-alt-caption">{alt === '' ? '(no alt)' : alt}</span>
      </figcaption>
      <input {...inputProps} placeholder="Describe the image" />
      <span {...handleProps} className={RESIZE_CLASS} />
    </figure>
  )
}

/** The `nodeViews.image` of the playground: the default view, or the hooks-only one in the `customImage` scenario. */
export function PlaygroundImageView(props: ImageProps) {
  return useContext(ImageViewKindContext) === 'custom' ? <HooksOnlyImageView {...props} /> : <DefaultImageView {...props} />
}
