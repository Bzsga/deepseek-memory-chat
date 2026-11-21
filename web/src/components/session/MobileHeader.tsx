import type { ReactNode } from 'react'
import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：菜单和新对话始终可用，会话页可补充标题与操作。 */
export const MobileHeader = ({ title, action }: { title?: string; action?: ReactNode }) => {
  const t = useTranslate()
  const pageTitle = title || t('appName')
  return (
    <header className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      <div className={styles.title} title={pageTitle}>
        {pageTitle}
      </div>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconNewChatOutline20 />}
        aria-label={t('newChat')}
        onClick={newChat}
      />
      {action}
    </header>
  )
}
