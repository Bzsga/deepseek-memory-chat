import { useEffect, useRef, useState, type HTMLAttributes } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isNativeConnected } from '../../services/nativeBridge.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { ImageViewer, type ImagePressHandlers } from './ImageViewer.js'
import styles from './ImageViewer.module.css'

/** The save link carries original bytes through the existing native Blob download handler. */
export const useImageActions = ({
  url,
  blob,
  name,
  alt,
}: {
  url: string | null | undefined
  blob: Blob | null | undefined
  name: string
  alt: string
}) => {
  const t = useTranslate()
  const [preview, setPreview] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
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
      setMenu(url)
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
        setPreview(url)
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
      setMenu(null)
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

  return {
    handlers,
    overlay: (
      <>
        {url && preview === url ? (
          <ImageViewer
            url={url}
            name={name}
            alt={alt}
            press={press}
            menuOpen={menu === url}
            onMenu={openMenu}
            onClose={() => setPreview(null)}
          />
        ) : null}
        {url && menu === url ? (
          <Modal
            title={t('imageOptions')}
            requireBackdropPointerDown
            onClose={() => setMenu(null)}
            footer={
              <div className={styles.menuActions}>
                <Button variant="outlined" onClick={() => setMenu(null)}>
                  {t('cancel')}
                </Button>
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
