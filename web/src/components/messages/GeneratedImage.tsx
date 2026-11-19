import { useEffect, useState } from 'react'
import { loadFile } from '../../services/chat/db.js'
import { getCachedGeneratedImage } from '../../services/chat/imageGeneration.js'
import { useTranslate } from '../../i18n/index.js'
import { useImageActions } from './useImageActions.js'
import styles from './GeneratedImage.module.css'

type GeneratedImageInfo = {
  id: string
  name: string
  mimeType: string
  prompt: string
}

type ImageState = {
  id: string
  blob: Blob | null
  url: string | null
}

export const GeneratedImage = ({ image }: { image: GeneratedImageInfo }) => {
  const t = useTranslate()
  const [state, setState] = useState<ImageState | null>(null)
  const [retry, setRetry] = useState(0)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const current = state?.id === image.id ? state : null
  const { handlers, overlay } = useImageActions({
    url: current?.url,
    blob: current?.blob,
    name: image.name,
    alt: image.prompt,
  })

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setState(null)
    const read = async () => {
      let blob = getCachedGeneratedImage(image.id)
      if (!blob) {
        try {
          blob = await loadFile(image.id)
        } catch {
          // A failed write may have completed while this read was waiting.
          blob = getCachedGeneratedImage(image.id)
        }
      }
      if (!cancelled) {
        objectUrl = blob ? URL.createObjectURL(blob) : null
        setState({ id: image.id, blob: blob ?? null, url: objectUrl })
      }
    }
    void read()
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [image.id, retry])

  const unavailable = current && (!current.url || failedUrl === current.url)
  return (
    <figure className={styles.figure}>
      {current?.url && failedUrl !== current.url ? (
        <button
          type="button"
          className={styles.preview}
          aria-label={t('imageOpen', { name: image.name })}
          {...handlers}
        >
          <img
            className={styles.image}
            src={current.url}
            alt={image.prompt}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailedUrl(current.url)}
          />
        </button>
      ) : (
        <div className={styles.placeholder} role="status">
          {t(unavailable ? 'imageOriginalUnavailable' : 'imageLoadingOriginal')}
        </div>
      )}
      {unavailable ? (
        <figcaption className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={() => setRetry((value) => value + 1)}
          >
            {t('imageReloadOriginal')}
          </button>
        </figcaption>
      ) : null}
      {overlay}
    </figure>
  )
}
