import { useTranslate } from '../../i18n/index.js'
import styles from './AboutSoftware.module.css'

export const AboutSoftware = () => {
  const t = useTranslate()
  const version = document
    .querySelector('meta[name="application-version"]')
    ?.getAttribute('content')
  return (
    <section className={styles.about} aria-label={t('aboutSoftware')}>
      <div className={styles.heading}>
        <h2>{t('appName')}</h2>
        {version ? <span>{t('aboutWebVersion', { version })}</span> : null}
      </div>
      <dl className={styles.credits}>
        <div>
          <dt>{t('aboutAuthor')}</dt>
          <dd>半盏丶时光</dd>
        </div>
        <div>
          <dt>{t('aboutAuthorContact')}</dt>
          <dd>QQ 1076755135</dd>
        </div>
        <div>
          <dt>{t('aboutProduction')}</dt>
          <dd>{t('aboutMadeWith')}</dd>
        </div>
      </dl>
      <div className={styles.upstream}>
        <h3>{t('aboutOpenSource')}</h3>
        <p>{t('aboutUpstreamStatement')}</p>
        <div className={styles.links}>
          <a
            href="https://github.com/deepseek-ai/chat-demo"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('aboutUpstreamLink')}
          </a>
          <a
            href="https://github.com/deepseek-ai/chat-demo/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('aboutLicense')}
          </a>
        </div>
        <p className={styles.notice}>{t('aboutThirdParty')}</p>
      </div>
    </section>
  )
}
