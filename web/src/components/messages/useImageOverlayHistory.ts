import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { canUseImageOverlayHistory } from '../../services/nativeBridge.js'
import { isSessionActive } from '../../services/runtime.js'
import { createId } from '../../utils/id.js'

type Layer = 'preview' | 'options' | 'preview-options'
type Entry = { token: string; layer: Layer; page: string }
type OpenImage = Entry & { url: string; stacked: boolean }

const readEntry = (): Entry | undefined => {
  const entry = history.state?.imageOverlay as Entry | undefined
  return entry?.page === location.href ? entry : undefined
}

const depth = (layer: Layer) => (layer === 'preview-options' ? 2 : 1)

/** Same-document entries let Android's existing WebView Back handler dismiss image UI. */
export const useImageOverlayHistory = (url: string | null | undefined) => {
  const [displayed, setDisplayed] = useState<OpenImage | null>(null)
  const active = useRef<OpenImage | null>(null)
  const closing = useRef(false)

  const display = useCallback((image: OpenImage | null) => {
    active.current = image
    setDisplayed(image)
  }, [])

  const tracking = displayed?.stacked === true
  useLayoutEffect(() => {
    if (!tracking) {
      return
    }
    const receive = () => {
      const image = active.current
      const entry = readEntry()
      closing.current = false
      if (!image) {
        return
      }
      if (entry?.token !== image.token || !isSessionActive()) {
        display(null)
      } else if (image.layer === 'preview-options' && entry.layer === 'preview') {
        display({ ...image, layer: 'preview' })
      } else if (entry.layer !== image.layer) {
        // A forward entry never recreates an options menu the user already dismissed.
        display(null)
      }
    }
    window.addEventListener('popstate', receive)
    receive()
    return () => window.removeEventListener('popstate', receive)
  }, [display, tracking])

  useLayoutEffect(() => () => {
    const image = active.current
    const entry = readEntry()
    active.current = null
    if (image?.stacked && !closing.current && entry?.token === image.token && isSessionActive()) {
      closing.current = true
      history.go(-depth(entry.layer))
    }
  }, [url])

  const open = (layer: 'preview' | 'options') => {
    const image = active.current
    if (!url || !isSessionActive() || closing.current || (image && image.layer !== 'preview')) {
      return
    }
    if (image && (layer === 'preview' || image.url !== url)) {
      return
    }
    const entry: Entry = {
      token: image?.token ?? createId(),
      layer: image ? 'preview-options' : layer,
      page: location.href,
    }
    const stacked = image?.stacked ?? canUseImageOverlayHistory()
    if (stacked) {
      history.pushState({ ...history.state, imageOverlay: entry }, '')
    }
    display({ ...entry, url, stacked })
  }

  const close = (onlyOptions = false) => {
    const image = active.current
    if (!image || closing.current || (onlyOptions && image.layer === 'preview')) {
      return
    }
    if (!image.stacked) {
      display(onlyOptions && image.layer === 'preview-options' ? { ...image, layer: 'preview' } : null)
      return
    }
    const entry = readEntry()
    if (entry?.token !== image.token || !isSessionActive()) {
      display(null)
      return
    }
    closing.current = true
    history.go(onlyOptions ? -1 : -depth(entry.layer))
  }

  const layer = displayed && displayed.url === url ? displayed.layer : null
  return {
    preview: layer === 'preview' || layer === 'preview-options',
    menu: layer === 'options' || layer === 'preview-options',
    openPreview: () => open('preview'),
    openOptions: () => open('options'),
    closePreview: () => close(),
    closeOptions: () => close(true),
  }
}
