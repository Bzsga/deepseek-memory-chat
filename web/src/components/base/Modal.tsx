import clsx from 'clsx'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMobileViewport } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层 */
const openModals: object[] = []

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  requireBackdropPointerDown = false,
  className,
  mainClassName,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  /** Menus opened during a held gesture wait for a fresh press on their backdrop. */
  requireBackdropPointerDown?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const overlayRef = useMobileViewport(true)
  const contentRef = useRef<HTMLDivElement>(null)
  const backdropPressed = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const token = {}
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    openModals.push(token)
    const focusFrame = requestAnimationFrame(() => {
      const first = contentRef.current?.querySelector<HTMLElement>(
        'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href]'
      )
      ;(first ?? contentRef.current)?.focus({ preventScroll: true })
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (openModals.at(-1) !== token) {
        return
      }
      if (event.key === 'Escape' && openModals.at(-1) === token) {
        onCloseRef.current()
      } else if (event.key === 'Tab') {
        const targets = Array.from(
          contentRef.current?.querySelectorAll<HTMLElement>(
            'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], [tabindex="0"]'
          ) ?? []
        ).filter((element) => element.getClientRects().length > 0)
        const first = targets[0]
        const last = targets.at(-1)
        if (!first) {
          event.preventDefault()
          contentRef.current?.focus()
          return
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !contentRef.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !contentRef.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openModals.splice(openModals.indexOf(token), 1)
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown)
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [])

  return createPortal(
    <div
      ref={overlayRef}
      className={styles.overlay}
      onPointerDown={(event) => {
        backdropPressed.current = event.target === event.currentTarget
      }}
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (!requireBackdropPointerDown || backdropPressed.current)
        ) {
          onClose()
        }
        backdropPressed.current = false
      }}
    >
      <div
        ref={contentRef}
        className={clsx(styles.content, className)}
        // Override callers' vh limits with the shared viewport hook's pixel size.
        style={{ maxHeight: 'calc(var(--app-viewport-height, 100vh) - 24px)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
