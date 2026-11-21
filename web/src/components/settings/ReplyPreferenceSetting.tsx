import clsx from 'clsx'
import { useId, useRef, useState, type FormEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatProvider } from '../../services/chatProvider.js'
import { OFFICIAL_BASE } from '../../services/providerEndpoint.js'
import {
  defaultReplyTuning,
  effortOptions,
  isEffort,
  isReplyApproach,
  isReplyDetail,
  isReplyTone,
  isReplyTuning,
  isTemperature,
  MAX_PERSONA_LENGTH,
  replyApproachOptions,
  replyDetailOptions,
  replyToneOptions,
  replyTuningNames,
  replyTuningOptions,
  type ReplyApproach,
  type ReplyDetail,
  type ReplyPreferences,
  type ReplyTone,
  type ReplyTuningName,
} from '../../services/replyPreferences.js'
import { setReplyPreferences, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SettingsEditRow } from './SettingsEditRow.js'
import styles from './ChatProviderSetting.module.css'
import layout from './ReplyPreferenceSetting.module.css'

const defaults: ReplyPreferences = {
  replyTone: 'default',
  replyDetail: 'default',
  replyApproach: 'default',
  persona: '',
  reasoningEffort: '',
  temperature: '',
  ...defaultReplyTuning,
}

const preferenceFields = [
  'replyTone', 'replyDetail', 'replyApproach', 'persona', 'reasoningEffort', 'temperature', ...replyTuningNames,
] as const
const samePreferences = (left: ReplyPreferences, right: ReplyPreferences) =>
  preferenceFields.every((name) => left[name] === right[name])
const countTuning = (preferences: ReplyPreferences) =>
  replyTuningNames.filter((name) => preferences[name] !== 'default').length

export function ReplyPreferenceSetting() {
  const [draft, setDraft] = useState<ReplyPreferences | null>(null)
  const [error, setError] = useState('')
  const saved: ReplyPreferences = useSettings(useShallow((state) => ({
    replyTone: state.replyTone,
    replyDetail: state.replyDetail,
    replyApproach: state.replyApproach,
    persona: state.persona,
    temperature: state.temperature,
    reasoningEffort: state.reasoningEffort,
    replyWarmth: state.replyWarmth,
    replyEnthusiasm: state.replyEnthusiasm,
    replyEmojis: state.replyEmojis,
    replyVisuals: state.replyVisuals,
    replyStructure: state.replyStructure,
  })))
  const { replyTone, replyDetail, replyApproach, reasoningEffort, temperature } = saved
  const zh = useSettings((state) => state.locale === 'zh-CN')
  const official = useChatProvider((state) => state.mode === 'managed' || state.endpoint.baseUrl === OFFICIAL_BASE)
  const formId = useId()
  const generationHelpId = useId()
  const temperatureErrorId = useId()
  const generationDetails = useRef<HTMLDetailsElement>(null)
  const temperatureInput = useRef<HTMLInputElement>(null)
  const title = zh ? '语气与回复偏好' : 'Tone and reply preferences'
  const toneLabels: Record<ReplyTone, string> = zh
    ? {
        default: '默认',
        direct: '简洁直接',
        warm: '温和自然',
        structured: '条理清晰',
        casual: '轻松随和',
        custom: '自定义',
      }
    : {
        default: 'Default',
        direct: 'Concise and direct',
        warm: 'Warm and natural',
        structured: 'Clearly structured',
        casual: 'Casual and friendly',
        custom: 'Custom',
      }
  const detailLabels: Record<ReplyDetail, string> = zh
    ? { default: '默认', brief: '简短', balanced: '适中', deep: '深入' }
    : { default: 'Default', brief: 'Brief', balanced: 'Balanced', deep: 'In depth' }
  const approachLabels: Record<ReplyApproach, string> = zh
    ? { default: '默认', direct: '直接给建议', compare: '对比选项和取舍', explore: '一起梳理问题' }
    : {
        default: 'Default',
        direct: 'Give advice directly',
        compare: 'Compare options and trade-offs',
        explore: 'Work through it together',
      }
  const effortLabels = zh
    ? { '': '模型默认', low: '低', medium: '中', high: '高', max: '最高' }
    : { '': 'Model default', low: 'Low', medium: 'Medium', high: 'High', max: 'Maximum' }
  const tuningLabels: Record<ReplyTuningName, string> = zh
    ? {
        replyWarmth: '亲切程度',
        replyEnthusiasm: '热情程度',
        replyEmojis: '表情符号',
        replyVisuals: '图表与可视化',
        replyStructure: '标题和列表',
      }
    : {
        replyWarmth: 'Warmth',
        replyEnthusiasm: 'Enthusiasm',
        replyEmojis: 'Emojis',
        replyVisuals: 'Charts and visuals',
        replyStructure: 'Headings and lists',
      }
  const tuningChoices = zh ? { default: '默认', less: '较少', more: '更多' } : { default: 'Default', less: 'Less', more: 'More' }
  const tuningGroups = [
    { title: zh ? '语气细节' : 'Tone details', names: ['replyWarmth', 'replyEnthusiasm', 'replyEmojis'] },
    { title: zh ? '内容排版' : 'Formatting', names: ['replyVisuals', 'replyStructure'] },
  ] as const
  const tuningCount = countTuning(saved)
  const summary = [
    toneLabels[replyTone],
    replyDetail !== 'default' && detailLabels[replyDetail],
    replyApproach !== 'default' && approachLabels[replyApproach],
    tuningCount > 0 && (zh ? `${tuningCount} 项细节已调整` : `${tuningCount} adjusted ${tuningCount === 1 ? 'detail' : 'details'}`),
    reasoningEffort && (zh ? `思考强度 ${effortLabels[reasoningEffort]}` : `Effort ${effortLabels[reasoningEffort]}`),
    temperature && (zh ? `温度 ${temperature}` : `Temperature ${temperature}`),
  ].filter(Boolean).join(' · ')

  function disclosure(title: string, count: number) {
    return (
      <summary className={layout.disclosure} tabIndex={0}>
        <span className={layout.disclosureLabels}>
          {title}
          {count > 0 ? <small className={layout.disclosureState}>{zh ? `${count} 项已设置` : `${count} set`}</small> : null}
        </span>
        <span className={layout.disclosureAction} aria-hidden="true">
          <span className={layout.openCue}>{zh ? '展开' : 'Expand'}</span>
          <span className={layout.closeCue}>{zh ? '收起' : 'Collapse'}</span>
        </span>
      </summary>
    )
  }

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
      if (generationDetails.current) {
        generationDetails.current.open = true
      }
      setError(
        zh
          ? '请输入 0 到 2 之间的数字，最多两位小数，或留空。'
          : 'Enter a number from 0 to 2 with up to two decimal places, or leave it blank.'
      )
      temperatureInput.current?.focus()
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
        onOpen={() => setDraft(saved)}
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
                disabled={samePreferences(draft, defaults)}
                onClick={() => change(defaults)}
              >
                {zh ? '恢复默认' : 'Reset to defaults'}
              </Button>
              <Button type="submit" form={formId} size="m" disabled={samePreferences(draft, saved)}>
                {zh ? '保存' : 'Save'}
              </Button>
            </div>
          }
        >
          <form id={formId} className={styles.section} onSubmit={save}>
            <label className={styles.field}>
              {zh ? '基础风格' : 'Base style'}
              <select
                className={styles.keyInput}
                value={draft.replyTone}
                onChange={(event) => {
                  if (isReplyTone(event.target.value)) {
                    change({ replyTone: event.target.value })
                  }
                }}
              >
                {replyToneOptions.map((value) => <option value={value} key={value}>{toneLabels[value]}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              {zh ? '回答详略' : 'Answer detail'}
              <select
                className={styles.keyInput}
                value={draft.replyDetail}
                onChange={(event) => {
                  if (isReplyDetail(event.target.value)) {
                    change({ replyDetail: event.target.value })
                  }
                }}
              >
                {replyDetailOptions.map((value) => <option value={value} key={value}>{detailLabels[value]}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              {zh ? '回应方式' : 'Response approach'}
              <select
                className={styles.keyInput}
                value={draft.replyApproach}
                onChange={(event) => {
                  if (isReplyApproach(event.target.value)) {
                    change({ replyApproach: event.target.value })
                  }
                }}
              >
                {replyApproachOptions.map((value) => <option value={value} key={value}>{approachLabels[value]}</option>)}
              </select>
            </label>
            {draft.replyTone === 'custom' ? (
              <>
                <label className={styles.field}>
                  {zh ? '自定义语气' : 'Custom tone'}
                  <textarea
                    className={styles.keyInput}
                    rows={3}
                    maxLength={MAX_PERSONA_LENGTH}
                    value={draft.persona}
                    placeholder={
                      zh
                        ? '例如：先给结论，再用简短的例子解释。'
                        : 'For example, lead with the answer and explain it with short examples.'
                    }
                    onChange={(event) => change({ persona: event.target.value })}
                  />
                </label>
                <p className={styles.description}>
                  {zh ? '留空时使用默认语气。' : 'Leave blank to use the default tone.'}
                </p>
              </>
            ) : null}
            <details className={layout.details}>
              {disclosure(zh ? '表达细节' : 'Expression details', countTuning(draft))}
              <div className={layout.disclosureBody}>
                {tuningGroups.map(({ title, names }) => (
                  <fieldset key={names[0]} className={layout.group}>
                    <legend className={layout.groupTitle}>{title}</legend>
                    {names.map((name) => (
                      <label key={name} className={layout.compactRow}>
                        <span>{tuningLabels[name]}</span>
                        <select
                          className={clsx(styles.keyInput, layout.compactSelect)}
                          value={draft[name]}
                          onChange={(event) => {
                            if (isReplyTuning(event.target.value)) {
                              change({ [name]: event.target.value })
                            }
                          }}
                        >
                          {replyTuningOptions.map((value) => <option value={value} key={value}>{tuningChoices[value]}</option>)}
                        </select>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            </details>
            <details ref={generationDetails} className={layout.details}>
              {disclosure(zh ? '生成参数' : 'Generation parameters', [draft.reasoningEffort, draft.temperature.trim()].filter(Boolean).length)}
              <div className={layout.disclosureBody}>
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
                      ref={temperatureInput}
                      className={styles.keyInput}
                      type="text"
                      inputMode="decimal"
                      maxLength={8}
                      placeholder={zh ? '默认（0–2）' : 'Default (0–2)'}
                      value={draft.temperature}
                      aria-invalid={!!error}
                      aria-describedby={error ? `${generationHelpId} ${temperatureErrorId}` : generationHelpId}
                      onChange={(event) => change({ temperature: event.target.value })}
                    />
                  </label>
                </div>
                <p id={generationHelpId} className={styles.description}>
                  {zh
                    ? '开启深度思考时使用思考强度。温度仅在关闭深度思考时生效，数值越高，回复越多样。留空使用模型默认值。'
                    : 'Reasoning effort applies with deep thinking on. Temperature applies only when it is off, and higher values make replies more varied. Leave it blank for the model default.'}
                </p>
                {error ? <p id={temperatureErrorId} role="alert" className={styles.error}>{error}</p> : null}
              </div>
            </details>
          </form>
        </Modal>
      ) : null}
    </>
  )
}
