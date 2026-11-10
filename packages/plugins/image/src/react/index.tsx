import type { ComponentType } from 'react'
import { resolveParts, type ViewCustomization } from '@penline/react'
import type { ImageProps } from './hooks'
import { Image, useImage, type ImagePartProps } from './parts'

export {
  useAltDraft,
  useImageResize,
  useImageState,
  type ImageAltDraftApi,
  type ImageAltInputProps,
  type ImageProps,
  type ImageResizeApi,
  type ImageResizeHandleProps,
  type ImageStateApi,
} from './hooks'
export { Image, useImage, useImageContext, type ImageApi, type ImagePartProps, type ImageRootProps } from './parts'

type ImageParts = {
  img: ComponentType<ImagePartProps>
  altInput: ComponentType<ImagePartProps>
  resizeHandle: ComponentType<ImagePartProps>
}

export type ImageViewProps = ImageProps & ViewCustomization<ImageParts>

/**
 * Default React node view of the image plugin: the picture, an alt-text input and a resize handle.
 * Stable attributes: `data-penline-image` on the root, `data-selected` when node-selected and
 * `data-uploading` while the upload is pending. `parts` / `classNames` keys: `root`, `img`,
 * `altInput`, `resizeHandle`.
 */
export function ImageView({ parts, classNames, ...props }: ImageViewProps) {
  const api = useImage(props)
  const P = resolveParts<ImageParts>({ img: Image.Img, altInput: Image.AltInput, resizeHandle: Image.ResizeHandle }, parts)
  return (
    <Image.Root value={api} className={classNames?.root}>
      {P.img && <P.img className={classNames?.img} />}
      {P.altInput && <P.altInput className={classNames?.altInput} />}
      {P.resizeHandle && <P.resizeHandle className={classNames?.resizeHandle} />}
    </Image.Root>
  )
}
