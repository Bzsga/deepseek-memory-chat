import { useId, useState, type FormEvent } from 'react'
import { useChatProvider } from '../../services/chatProvider.js'
import { OFFICIAL_BASE } from '../../services/providerEndpoint.js'
import {
  effortOptions,
  isEffort,
  isTemperature,
  MAX_PERSONA_LENGTH,
  type ReplyPreferences,
} from '../../services/replyPreferences.js'
import { setReplyPreferences, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SettingsEditRow } from './SettingsEditRow.js'
import styles from './ChatProviderSetting.module.css'

const defaults: ReplyPreferences = { persona: '', reasoningEffort: '', temperature: '' }

export function ReplyPreferenceSetting() {
  const [draft, setDraft] = useState<ReplyPreferences | null>(null)
  const [error, setError] = useState('')
  const persona = useSettings((state) => state.persona)
  const temperature = useSettings((state) => state.temperature)
  const reasoningEffort = useSettings((state) => state.reasoningEffort)
  const zh = useSettings((state) => state.locale === 'zh-CN')
  const official = useChatProvider((state) => state.mode === 'managed' || state.endpoint.baseUrl === OFFICIAL_BASE)
  const formId = useId()
  const title = zh ? '人格与回复偏好' : 'Persona and reply preferences'
  const effortLabels = zh
    ? { '': '模型默认', low: '低', medium: '中', high: '高', max: '最高' }
    : { '': 'Model default', low: 'Low', medium: 'Medium', high: 'High', max: 'Maximum' }
  const summary = [
    persona && (zh ? '自定义人格' : 'Custom persona'),
    reasoningEffort && (zh ? `思考强度 ${effortLabels[reasoningEffort]}` : `Effort ${effortLabels[reasoningEffort]}`),
    temperature && (zh ? `温度 ${temperature}` : `Temperature ${temperature}`),
  ].filter(Boolean).join(' · ') || (zh ? '模型默认' : 'Model defaults')

  function close() {
    setDraft(null)
    setError('')
  }

  function change(changes: Partial<ReplyPreferences>) {
    setDraft((previous) => previous ? { ...previous, ...changes } : previous)
    setError('')
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) {
      return
    }
    const value = draft.temperature.trim()
    if (!isTemperature(value)) {
      setError(
        zh
          ? '请输入 0 到 2 之间的数字，最多两位小数，或留空。'
          : 'Enter a number from 0 to 2 with up to two decimal places, or leave it blank.'
      )
      return
    }
    setReplyPreferences({ ...draft, persona: draft.persona.trim(), temperature: value })
    close()
    showToast(zh ? '已保存回复偏好' : 'Reply preferences saved')
  }

  return (
    <>
      <SettingsEditRow
        label={title}
        summary={summary}
        onOpen={() => setDraft({ persona, temperature, reasoningEffort })}
      />
      {draft ? (
        <Modal
          title={title}
          className={styles.dialog}
          closable
          onClose={close}
          footer={
            <div className={styles.footerActions}>
              <Button
                variant="outlined"
                size="m"
                disabled={!draft.persona && !draft.reasoningEffort && !draft.temperature}
                onClick={() => change(defaults)}
              >
                {zh ? '恢复默认' : 'Reset to defaults'}
              </Button>
              <Button type="submit" form={formId} size="m" disabled={
                draft.persona === persona && draft.reasoningEffort === reasoningEffort && draft.temperature === temperature
              }>
                {zh ? '保存' : 'Save'}
              </Button>
            </div>
          }
        >
          <form id={formId} className={styles.section} onSubmit={save}>
            <label className={styles.field}>
              {zh ? '模型人格' : 'Assistant persona'}
              <textarea
                className={styles.keyInput}
                rows={3}
                maxLength={MAX_PERSONA_LENGTH}
                value={draft.persona}
                placeholder={
                  zh
                    ? '例如：先给出结论，再用简短例子解释。'
                    : 'For example, give the answer first and explain it with short examples.'
                }
                onChange={(event) => change({ persona: event.target.value })}
              />
            </label>
            <p className={styles.description}>
              {zh
                ? '应用于后续聊天回复。留空使用默认风格。'
                : 'Applies to future chat replies. Leave blank for the default style.'}
            </p>
            <div className={styles.fields}>
              <label className={styles.field}>
                {zh ? '思考强度' : 'Reasoning effort'}
                <select
                  className={styles.keyInput}
                  value={draft.reasoningEffort}
                  onChange={(event) => {
                    if (isEffort(event.target.value)) {
                      change({ reasoningEffort: event.target.value })
                    }
                  }}
                >
                  {effortOptions
                    .filter((value) => !official || value !== 'medium' || value === draft.reasoningEffort)
                    .map((value) => <option value={value} key={value}>{effortLabels[value]}</option>)}
                </select>
              </label>
              <label className={styles.field}>
                {zh ? '温度' : 'Temperature'}
                <input
                  className={styles.keyInput}
                  type="text"
                  inputMode="decimal"
                  maxLength={8}
                  placeholder={zh ? '默认（0–2）' : 'Default (0–2)'}
                  value={draft.temperature}
                  onChange={(event) => change({ temperature: event.target.value })}
                />
              </label>
            </div>
            <p className={styles.description}>
              {zh
                ? '深度思考开启时使用所选强度，关闭时使用温度。参数支持情况取决于模型。'
                : 'Reasoning effort applies with deep thinking on. Temperature applies with it off. Support varies by model.'}
            </p>
            {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          </form>
        </Modal>
      ) : null}
    </>
  )
}
