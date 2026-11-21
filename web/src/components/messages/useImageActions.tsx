import { useEffect, useMemo, useRef, type HTMLAttributes } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { resolveImageEditSource } from '../../services/imageEditSource.js'
import { useActiveImageProvider } from '../../services/imageProvider.js'
import { isNativeConnected } from '../../services/nativeBridge.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { ImageViewer, type ImagePressHandlers } from './ImageViewer.js'
import { useImageOverlayHistory } from './useImageOverlayHistory.js'
import styles from './ImageViewer.module.css'

/** The save link carries original bytes through the existing native Blob download handler. */
export const useImageActions = ({
  url,
  blob,
  name,
  mimeType,
  alt,
  editSessionId,
}: {
  url: string | null | undefined
  blob: Blob | null | undefined
  name: string
  mimeType?: string
  alt: string
  editSessionId?: string
}) => {
  const t = useTranslate()
  const imageProvider = useActiveImageProvider()
  const { preview, menu, openPreview, openOptions, closePreview, closeOptions } =
    useImageOverlayHistory(url)
  const editSource = useMemo(() => {
    if (!editSessionId || !imageProvider || !blob || (!preview && !menu)) {
      return undefined
    }
    const result = resolveImageEditSource([new File([blob], name, { type: mimeType || blob.type })])
    return 'source' in result ? result.source : undefined
  }, [editSessionId, imageProvider, blob, preview, menu, name, mimeType])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const origin = useRef<{ id: number; x: number; y: number } | null>(null)
  const suppressClickUntil = useRef(0)
  const cancelPress = () => {
    clearTimeout(timer.current)
    timer.current = undefined
    origin.current = null
  }
  useEffect(() => cancelPress, [url])

  const openMenu = () => {
    if (url && blob) {
      cancelPress()
      suppressClickUntil.current = Date.now() + 800
      openOptions()
    }
  }
  const press: ImagePressHandlers = {
    onPointerDown: (event) => {
      cancelPress()
      if (!event.isPrimary) {
        suppressClickUntil.current = Date.now() + 800
        return
      }
      suppressClickUntil.current = 0
      if (event.pointerType === 'mouse' || event.button !== 0 || !url || !blob) {
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      origin.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
      timer.current = setTimeout(openMenu, 450)
    },
    onPointerMove: (event) => {
      const start = origin.current
      if (
        start &&
        (start.id !== event.pointerId ||
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12)
      ) {
        cancelPress()
      }
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: (event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        cancelPress()
      }
    },
    onContextMenu: (event) => {
      event.preventDefault()
      openMenu()
    },
  }
  const handlers: HTMLAttributes<HTMLElement> = {
    ...press,
    onClick: (event) => {
      event.preventDefault()
      if (Date.now() < suppressClickUntil.current) {
        suppressClickUntil.current = 0
        event.stopPropagation()
        return
      }
      if (url && blob) {
        openPreview()
      }
    },
  }
  const save = () => {
    if (!blob) {
      return
    }
    let downloadUrl: string | undefined
    let anchor: HTMLAnchorElement | undefined
    try {
      downloadUrl = URL.createObjectURL(blob)
      anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = name
      anchor.hidden = true
      document.body.append(anchor)
      anchor.click()
      closeOptions()
    } catch {
      showToast({ key: 'imageSaveFailed', type: 'error' })
    } finally {
      anchor?.remove()
      if (downloadUrl) {
        const retained = downloadUrl
        setTimeout(() => URL.revokeObjectURL(retained), 10_000)
      }
    }
  }

  const edit = editSource && editSessionId
    ? () => {
        const accepted = document.dispatchEvent(new CustomEvent('deepseek:use-image-for-edit', {
          cancelable: true,
          detail: { sessionId: editSessionId, source: editSource },
        }))
        if (accepted) {
          closePreview()
        }
      }
    : undefined

  return {
    handlers,
    overlay: (
      <>
        {url && preview ? (
          <ImageViewer
            url={url}
            name={name}
            alt={alt}
            press={press}
            menuOpen={menu}
            onMenu={openMenu}
            onEdit={edit}
            onClose={closePreview}
          />
        ) : null}
        {url && menu ? (
          <Modal
            title={t('imageOptions')}
            requireBackdropPointerDown
            onClose={closeOptions}
            footer={
              <div className={styles.menuActions}>
                <Button variant="outlined" onClick={closeOptions}>
                  {t('cancel')}
                </Button>
                {edit ? (
                  <Button variant="outlined" onClick={edit}>
                    {t('imageEditThisImage')}
                  </Button>
                ) : null}
                <Button onClick={save}>
                  {t(isNativeConnected() ? 'imageSaveToAlbum' : 'imageSave')}
                </Button>
              </div>
            }
          >
            <p className={styles.menuName}>{name}</p>
          </Modal>
        ) : null}
      </>
    ),
  }
}
