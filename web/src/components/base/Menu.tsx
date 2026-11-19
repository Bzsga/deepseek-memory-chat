import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  children,
  align = 'start',
}: {
  options: MenuOption[]
  align?: 'start' | 'end'
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const restoreFocus = useRef(false)
  const close = () => {
    restoreFocus.current = true
    setOpen(false)
  }
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align, alignOffset: align === 'start' ? -5 : 0, offset: 4 }
  )
  useDismiss(open, [anchorRef, floatingRef], close)
  useEffect(() => {
    if (open) {
      floatingRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    } else if (restoreFocus.current) {
      anchorRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
      restoreFocus.current = false
    }
  }, [open, anchorRef, floatingRef])

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
              onKeyDown={(event) => {
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
                )
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  buttons[
                    (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
                  ]?.focus()
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  close()
                }
              }}
            >
              {options.map((option) => (
                <button
                  type="button"
                  key={option.key}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  disabled={option.disabled}
                  onClick={() => {
                    close()
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
