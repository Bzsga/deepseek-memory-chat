/** Android's scroll-capture callback only exchanges geometry, never message contents. */
export type ScrollCaptureMetrics = {
  left: number
  top: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  scrollTop: number
  scrollHeight: number
}

type CaptureHost = {
  metrics: (id?: number) => ScrollCaptureMetrics | null
  start: (id: number) => ScrollCaptureMetrics | null
  scroll: (id: number, top: number) => ScrollCaptureMetrics | null
  end: (id: number) => boolean
}

declare global {
  interface Window {
    __deepseekScrollCapture?: CaptureHost
  }
}

/** Register only the mounted message window; pagination remains under the user's control. */
export const registerScrollCapture = (
  element: HTMLElement,
  options: {
    available: () => boolean
    content?: () => Element | null | undefined
    header?: () => Element | null | undefined
    footer: () => Element | null | undefined
    start: () => () => void
  }
) => {
  window.__deepseekScrollCapture?.end(0)
  let active:
    | {
        id: number
        top: number
        metrics: ScrollCaptureMetrics
        restore: () => void
        behavior: string
        anchor: string
      }
    | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(() => finish())

  const finish = (id = 0) => {
    if (!active || (id !== 0 && id !== active.id)) {
      return false
    }
    const saved = active
    active = undefined
    clearTimeout(timer)
    observer.disconnect()
    element.scrollTop = saved.top
    element.style.scrollBehavior = saved.behavior
    element.style.overflowAnchor = saved.anchor
    saved.restore()
    return true
  }
  const renew = () => {
    clearTimeout(timer)
    // A crashed/disconnected host must not leave reading/auto-follow suspended.
    timer = setTimeout(() => finish(), 15000)
  }
  const read = (): ScrollCaptureMetrics | null => {
    if (
      !element.isConnected ||
      !options.available() ||
      document.visibilityState !== 'visible' ||
      (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01) ||
      [
        ...document.querySelectorAll(
          '[aria-modal="true"], dialog[open], [role="menu"], [role="listbox"]'
        ),
      ].some(
        (modal) =>
          modal.getClientRects().length > 0 && getComputedStyle(modal).visibility === 'visible'
      )
    ) {
      return null
    }
    const documentScroll = element === document.scrollingElement
    const rect = element.getBoundingClientRect()
    const left = documentScroll ? 0 : rect.left + element.clientLeft
    const top = documentScroll
      ? Math.max(0, options.header?.()?.getBoundingClientRect().bottom ?? 0)
      : rect.top + element.clientTop
    const bottom = Math.min(
      documentScroll ? innerHeight : top + element.clientHeight,
      options.footer()?.getBoundingClientRect().top ?? Infinity
    )
    const height = bottom - top
    const width = documentScroll ? innerWidth : element.clientWidth
    if (
      width < 1 ||
      height < 1 ||
      left < -0.5 ||
      top < -0.5 ||
      left + width > innerWidth + 0.5 ||
      bottom > innerHeight + 0.5
    ) {
      return null
    }
    // Hit tests also reject non-modal menus, image viewers, and other overlays.
    const content = options.content?.() ?? element
    for (const x of [left + 2, left + width / 2, left + width - 2]) {
      for (const y of [top + 2, top + height / 2, bottom - 2]) {
        const hit = document.elementFromPoint(x, y)
        if (!hit || (hit !== content && !content.contains(hit))) {
          return null
        }
      }
    }
    return {
      left,
      top,
      width,
      height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      scrollTop: element.scrollTop,
      // The full document viewport also includes fixed header/composer space.
      scrollHeight: element.scrollHeight - (element.clientHeight - height),
    }
  }
  const metrics = (id = 0) => {
    if (id !== 0 && active?.id !== id) {
      return null
    }
    const current = read()
    const saved = active?.metrics
    if (
      saved &&
      (!current ||
        (Object.keys(saved) as (keyof ScrollCaptureMetrics)[]).some(
          (key) => key !== 'scrollTop' && Math.abs(saved[key] - current[key]) > 0.5
        ))
    ) {
      finish()
      return null
    }
    if (id === 0 && active) {
      return null
    }
    if (id !== 0) {
      renew()
    }
    return current
  }
  const host: CaptureHost = {
    metrics,
    start: (id) => {
      if (!Number.isSafeInteger(id) || id <= 0) {
        return null
      }
      finish()
      const initial = read()
      if (!initial || initial.scrollHeight <= initial.height + 1) {
        return null
      }
      active = {
        id,
        top: element.scrollTop,
        metrics: initial,
        restore: options.start(),
        behavior: element.style.scrollBehavior,
        anchor: element.style.overflowAnchor,
      }
      element.style.scrollBehavior = 'auto'
      element.style.overflowAnchor = 'none'
      observer.observe(options.content?.() ?? element, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      })
      renew()
      return initial
    },
    scroll: (id, top) => {
      if (!Number.isFinite(top) || !metrics(id)) {
        return null
      }
      element.scrollTop = top
      return metrics(id)
    },
    end: finish,
  }
  window.__deepseekScrollCapture = host
  const interrupt = () => {
    finish()
  }
  for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown', 'pagehide']) {
    window.addEventListener(event, interrupt, { capture: true, passive: true })
  }
  return () => {
    finish()
    observer.disconnect()
    for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown', 'pagehide']) {
      window.removeEventListener(event, interrupt, true)
    }
    if (window.__deepseekScrollCapture === host) {
      delete window.__deepseekScrollCapture
    }
  }
}
