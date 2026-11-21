import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

/** 窄于 768px 按移动端布局 */
const query = window.matchMedia('not all and (min-width: 768px)')
let lastPositiveHeight: number | undefined
const positiveFinite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0

const subscribe = (onChange: () => void) => {
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export const useIsMobile = () => useSyncExternalStore(subscribe, () => query.matches)

const preventPageScroll = (event: TouchEvent) => {
  if (event.touches.length !== 1) {
    return
  }
  for (
    let element = event.target instanceof Element ? event.target : null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    const scrollsY =
      /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight
    const scrollsX =
      /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth
    if (scrollsY || scrollsX) {
      return
    }
  }
  if (
    document.documentElement.hasAttribute('data-chat-document-scroll') &&
    event.target instanceof Element &&
    event.target.closest('[data-chat-message-scroll]')
  ) {
    return
  }
  event.preventDefault()
}

/** Keep overlays still while allowing their controls and the chat document to scroll. */
export const usePreventPageScroll = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    document.addEventListener('touchmove', preventPageScroll, { passive: false })
    return () => document.removeEventListener('touchmove', preventPageScroll)
  }, [enabled])
}

/** 移动端页面跟随视觉视口，键盘弹出后顶栏和输入框仍留在可见区域。 */
export const useMobileViewport = (
  enabled: boolean,
  { followVisualViewport = false }: { followVisualViewport?: boolean } = {}
) => {
  const frameRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) {
      return
    }
    const viewport = window.visualViewport
    const inputSelector = 'textarea, input:not([type="file"])'
    let animationFrame = 0
    let frameHeight: number | undefined
    const reset = () => {
      frame.style.removeProperty('--app-viewport-height')
      frame.style.removeProperty('--app-viewport-top')
      frame.style.removeProperty('--app-viewport-bottom-inset')
    }
    const update = () => {
      // 双指缩放由浏览器处理，保持当前布局尺寸。
      if (viewport && (!Number.isFinite(viewport.scale) || Math.abs(viewport.scale - 1) > 0.001)) {
        return
      }
      const inputFocused = document.activeElement?.matches(inputSelector)
      const layoutHeight = window.innerHeight
      const visualHeight = viewport?.height
      // A dialog must still fit above the keyboard after the field blurs. During
      // native resize, the layout and visual viewports may update in different frames.
      const dialogHeights = followVisualViewport && viewport
        ? [positiveFinite(visualHeight) ? visualHeight : frameHeight, layoutHeight].filter(positiveFinite)
        : []
      // WebView can report a transient zero while its native host is resizing.
      // Keep the last usable size rather than collapsing the entire chat.
      const height = dialogHeights.length
        ? Math.min(...dialogHeights)
        : [inputFocused ? visualHeight : layoutHeight, layoutHeight, document.documentElement.clientHeight]
            .find(positiveFinite)
      if (height === undefined) {
        // A portal mounted during native resizing has no per-frame measurement
        // yet. Seed it from the last usable height observed by any existing frame.
        if (
          lastPositiveHeight !== undefined &&
          !frame.style.getPropertyValue('--app-viewport-height')
        ) {
          frame.style.setProperty('--app-viewport-height', `${lastPositiveHeight}px`)
          frame.style.setProperty('--app-viewport-top', '0px')
        }
        return
      }
      frameHeight = height
      lastPositiveHeight = height
      const offsetTop = (followVisualViewport || inputFocused) ? viewport?.offsetTop : undefined
      const visualTop = positiveFinite(offsetTop) ? offsetTop : 0
      const top = followVisualViewport && positiveFinite(layoutHeight)
        ? Math.min(visualTop, Math.max(0, layoutHeight - height))
        : visualTop
      frame.style.setProperty('--app-viewport-height', `${height}px`)
      frame.style.setProperty('--app-viewport-top', `${top}px`)
      const bottomInset =
        inputFocused && Number.isFinite(layoutHeight) && layoutHeight > 0
          ? Math.max(0, layoutHeight - height - top)
          : 0
      frame.style.setProperty('--app-viewport-bottom-inset', `${bottomInset}px`)
    }
    const scheduleFrame = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(update)
    }
    const schedule = () => {
      // 先同步跟上键盘动画，下一帧再校准 Safari 延迟更新的视口读数。
      if (!followVisualViewport) {
        update()
      }
      scheduleFrame()
    }
    const onFocusIn = () => {
      if (document.activeElement?.matches(inputSelector)) {
        schedule()
      }
    }

    update()
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', onFocusIn)
    // 等点击和焦点切换完成，避免按钮移动、或切换输入框时短暂恢复全高。
    document.addEventListener('focusout', scheduleFrame)
    return () => {
      cancelAnimationFrame(animationFrame)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', scheduleFrame)
      reset()
    }
  }, [enabled, followVisualViewport])

  return frameRef
}
