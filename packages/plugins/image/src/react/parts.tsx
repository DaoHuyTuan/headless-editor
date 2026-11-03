import { createContext, useContext, type ReactNode } from 'react'
import { dataAttrs } from '@hte/react'
import { safeSrc } from '../src-policy'
import {
  useAltDraft,
  useImageResize,
  useImageState,
  type ImageAltInputProps,
  type ImageProps,
  type ImageResizeHandleProps,
} from './hooks'

/** @experimental Level 3 customization API; may change after M3 without a deprecation cycle. */
export interface ImageApi {
  /** `data.src` when it passes `safeSrc`, else undefined. */
  src: string | undefined
  alt: string
  /** The width to render (live while resizing). */
  width: number | undefined
  selected: boolean
  uploading: boolean
  resizing: boolean
  inputProps: ImageAltInputProps
  handleProps: ImageResizeHandleProps
}

/**
 * The three image hooks combined into the value `Image.Root` provides to its parts.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export function useImage(props: ImageProps): ImageApi {
  const { selected, uploading } = useImageState(props)
  const { width, resizing, handleProps } = useImageResize(props)
  const { inputProps } = useAltDraft(props)
  const { src, alt } = props.node.data
  return { src: safeSrc(src) ?? undefined, alt, width, selected, uploading, resizing, inputProps, handleProps }
}

const ImageContext = createContext<ImageApi | null>(null)

/**
 * The `ImageApi` provided by `Image.Root`, for replacement parts.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export function useImageContext(): ImageApi {
  const value = useContext(ImageContext)
  if (!value) throw new Error('@hte/image: Image parts must be rendered inside <Image.Root>')
  return value
}

/** @experimental */
export interface ImageRootProps {
  value: ImageApi
  className?: string
  children?: ReactNode
}

/** @experimental */
export interface ImagePartProps {
  className?: string
}

/**
 * The parts of the image view. `Root` is `<figure data-hte-image data-selected? data-uploading?>`
 * and provides the `ImageApi` (live width, alt draft, resize handlers) to the other parts; `Img` is
 * the picture (src behind `safeSrc`); `AltInput` the alt text `<input>`; `ResizeHandle` the drag
 * handle `<span>`. The controls get `data-editor-ignore` from the hooks' props.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export const Image = {
  Root({ value, className, children }: ImageRootProps) {
    return (
      <ImageContext.Provider value={value}>
        <figure
          data-hte-image=""
          {...dataAttrs({ selected: value.selected, uploading: value.uploading })}
          className={className}
        >
          {children}
        </figure>
      </ImageContext.Provider>
    )
  },
  Img({ className }: ImagePartProps) {
    const { src, alt, width } = useImageContext()
    return <img src={src} alt={alt} width={width} draggable={false} className={className} />
  },
  AltInput({ className }: ImagePartProps) {
    const { inputProps } = useImageContext()
    return <input {...inputProps} className={className} />
  },
  ResizeHandle({ className }: ImagePartProps) {
    const { handleProps } = useImageContext()
    return <span {...handleProps} className={className} />
  },
}
