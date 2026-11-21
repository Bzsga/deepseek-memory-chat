import { useEffect, useRef, useState, type HTMLAttributes, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useMobileViewport } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import styles from './ImageViewer.module.css'

export type ImagePressHandlers = Pick<
  HTMLAttributes<HTMLElement>,
  | 'onPointerDown'
  | 'onPointerMove'
  | 'onPointerUp'
  | 'onPointerCancel'
  | 'onPointerLeave'
  | 'onContextMenu'
>

type Point = { x: number; y: number }
type Transform = Point & { scale: number }
type Gesture = { points: Point[]; transform: Transform }
const initial: Transform = { x: 0, y: 0, scale: 1 }

export const ImageViewer = ({
  url,
  name,
  alt,
  menuOpen,
  press,
  onMenu,
  onEdit,
  onClose,
}: {
  url: string
  name: string
  alt: string
  menuOpen: boolean
  press: ImagePressHandlers
  onMenu: () => void
  onEdit?: () => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const viewportRef = useMobileViewport(true)
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  const transformRef = useRef(initial)
  const [transform, setTransform] = useState(initial)
  const [failed, setFailed] = useState(false)
  const menuRef = useRef(menuOpen)
  const closeRef = useRef(onClose)
  menuRef.current = menuOpen
  closeRef.current = onClose

  const apply = (next: Transform) => {
    const stage = stageRef.current
    const image = imageRef.current
    const scale = Math.max(1, Math.min(5, next.scale))
    const maxX = Math.max(0, ((image?.clientWidth ?? 0) * scale - (stage?.clientWidth ?? 0)) / 2)
    const maxY = Math.max(0, ((image?.clientHeight ?? 0) * scale - (stage?.clientHeight ?? 0)) / 2)
    const value = {
      scale,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    }
    transformRef.current = value
    setTransform(value)
  }

  const zoomAt = (scale: number, x?: number, y?: number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    const current = transformRef.current
    const nextScale = Math.max(1, Math.min(5, scale))
    const focusX = x !== undefined && rect ? x - rect.left - rect.width / 2 : 0
    const focusY = y !== undefined && rect ? y - rect.top - rect.height / 2 : 0
    apply({
      scale: nextScale,
      x: focusX - ((focusX - current.x) * nextScale) / current.scale,
      y: focusY - ((focusY - current.y) * nextScale) / current.scale,
    })
  }

  useEffect(() => {
    const viewer = viewportRef.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true })
    })
    const keydown = (event: KeyboardEvent) => {
      if (menuRef.current) {
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomAt(transformRef.current.scale * 1.25)
      } else if (event.key === '-') {
        event.preventDefault()
        zoomAt(transformRef.current.scale / 1.25)
      } else if (event.key === '0') {
        apply(initial)
      } else if (event.key === 'Tab') {
        const buttons = [...(viewer?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(
          (button) => !button.disabled
        )
        const first = buttons[0]
        const last = buttons.at(-1)
        if (
          event.shiftKey &&
          (document.activeElement === first || !viewer?.contains(document.activeElement))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !viewer?.contains(document.activeElement))
        ) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    const stage = stageRef.current
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      zoomAt(
        transformRef.current.scale * Math.exp(-event.deltaY * 0.002),
        event.clientX,
        event.clientY
      )
    }
    document.addEventListener('keydown', keydown, true)
    stage?.addEventListener('wheel', wheel, { passive: false })
    const resize = new ResizeObserver(() => apply(transformRef.current))
    if (stage) {
      resize.observe(stage)
    }
    if (imageRef.current) {
      resize.observe(imageRef.current)
    }
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown, true)
      stage?.removeEventListener('wheel', wheel)
      resize.disconnect()
      previous?.isConnected && previous.focus({ preventScroll: true })
    }
  }, [viewportRef])

  const beginGesture = () => {
    gesture.current = {
      points: [...pointers.current.values()].slice(0, 2),
      transform: { ...transformRef.current },
    }
  }
  const endPointer = (event: PointerEvent<HTMLElement>) => {
    press.onPointerUp?.(event)
    pointers.current.delete(event.pointerId)
    beginGesture()
  }

  return createPortal(
    <div
      ref={viewportRef}
      className={styles.viewer}
      role="dialog"
      aria-modal="true"
      aria-label={t('imagePreview')}
    >
      <div className={styles.header}>
        <span className={styles.name}>{name}</span>
        {onEdit && !failed ? (
          <button type="button" className={clsx(styles.control, styles.editControl)} onClick={onEdit}>
            {t('imageEditThisImage')}
          </button>
        ) : null}
        <button
          ref={closeButtonRef}
          type="button"
          className={styles.control}
          aria-label={t('close')}
          onClick={onClose}
        >
          <IconCloseOutline16 />
        </button>
      </div>
      <div
        ref={stageRef}
        className={styles.stage}
        onContextMenu={press.onContextMenu}
        onPointerDown={(event) => {
          press.onPointerDown?.(event)
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          event.currentTarget.setPointerCapture(event.pointerId)
          beginGesture()
        }}
        onPointerMove={(event) => {
          press.onPointerMove?.(event)
          if (!pointers.current.has(event.pointerId) || !gesture.current) {
            return
          }
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          const points = [...pointers.current.values()].slice(0, 2)
          const start = gesture.current
          if (points.length === 2 && start.points.length === 2) {
            const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
            const originalDistance = Math.hypot(
              start.points[1].x - start.points[0].x,
              start.points[1].y - start.points[0].y
            )
            if (originalDistance < 1) {
              return
            }
            const rect = event.currentTarget.getBoundingClientRect()
            const center = (values: Point[]) => ({
              x: (values[0].x + values[1].x) / 2 - rect.left - rect.width / 2,
              y: (values[0].y + values[1].y) / 2 - rect.top - rect.height / 2,
            })
            const before = center(start.points)
            const after = center(points)
            const scale = Math.max(
              1,
              Math.min(5, (start.transform.scale * distance) / originalDistance)
            )
            apply({
              scale,
              x: after.x - ((before.x - start.transform.x) * scale) / start.transform.scale,
              y: after.y - ((before.y - start.transform.y) * scale) / start.transform.scale,
            })
          } else if (points.length === 1 && start.points.length === 1) {
            apply({
              scale: start.transform.scale,
              x: start.transform.x + points[0].x - start.points[0].x,
              y: start.transform.y + points[0].y - start.points[0].y,
            })
          }
        }}
        onPointerUp={endPointer}
        onPointerCancel={(event) => {
          press.onPointerCancel?.(event)
          pointers.current.delete(event.pointerId)
          beginGesture()
        }}
        onDoubleClick={(event) => {
          event.preventDefault()
          zoomAt(transformRef.current.scale > 1 ? 1 : 2, event.clientX, event.clientY)
        }}
      >
        {failed ? <span role="alert">{t('imageOriginalUnavailable')}</span> : null}
        <img
          ref={imageRef}
          className={styles.image}
          src={url}
          alt={alt}
          draggable={false}
          hidden={failed}
          style={{
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          }}
          onLoad={() => apply(transformRef.current)}
          onError={() => setFailed(true)}
        />
      </div>
      <div className={styles.toolbar}>
        <div className={styles.zoom}>
          <button
            type="button"
            className={styles.control}
            aria-label={t('imageZoomOut')}
            disabled={transform.scale <= 1}
            onClick={() => zoomAt(transformRef.current.scale / 1.25)}
          >
            −
          </button>
          <button
            type="button"
            className={styles.reset}
            aria-label={t('imageResetZoom')}
            onClick={() => apply(initial)}
          >
            {Math.round(transform.scale * 100)}%
          </button>
          <button
            type="button"
            className={styles.control}
            aria-label={t('imageZoomIn')}
            disabled={transform.scale >= 5}
            onClick={() => zoomAt(transformRef.current.scale * 1.25)}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className={styles.control}
          aria-label={t('imageOptions')}
          onClick={onMenu}
        >
          ⋯
        </button>
      </div>
    </div>,
    document.body
  )
}
