import { useActiveImageProvider } from '../../services/imageProvider.js'
import { GeneratedImage } from './GeneratedImage.js'
import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo } from 'react'
import { IconRefreshOutline16, IconWarningOutline16, IconShareOutline16 } from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { canContinueReply, recoverableImagePrompts } from '../../services/chat/reply.js'
import {
  cancelImageJob,
  drawFromReplyDescriptions,
  continueReply,
  regenerateReply,
  resumeImageJob,
  retryImageJobSubmission,
} from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onShare,
  shareDisabled,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onShare: (messageId: string) => void
  shareDisabled: boolean
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const imageProvider = useActiveImageProvider()
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const imageJob = message.imageJob
  const describedCount = imageProvider && !streaming ? recoverableImagePrompts(message).length : 0
  const showImageJob =
    !!imageJob &&
    message.status !== 'done' &&
    (!!imageJob.prompts || !message.blocks.some((block) => block.type === 'image'))
  const pendingImageJob =
    showImageJob &&
    !!imageJob &&
    !['unknown', 'expired', 'cancelled', 'failed'].includes(imageJob.state)
  const notice = streaming || showImageJob ? null : describeReply(message)
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const summaryEntry = `${message.id}-summary`
  return (
    <div className={styles.message} data-chat-message={message.id}>
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      {answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={answer.markdown}
          loading={streaming}
          cacheKey={message.id}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {refused
        ? null
        : message.blocks.map((block) =>
            block.type === 'image' ? <GeneratedImage key={block.id} image={block} /> : null
          )}
      {describedCount > 0 && (
        <Button type="button" variant="outlined" size="s" disabled={busy} onClick={() => drawFromReplyDescriptions(sessionId, message.id)}>
          {t('drawDescribedImages', { count: describedCount })}
        </Button>
      )}
      {showImageJob && imageJob ? (
        <ImageJobNotice
          sessionId={sessionId}
          messageId={message.id}
          job={imageJob}
          imageProvider={imageProvider}
          pending={pendingImageJob}
          busy={busy}
        />
      ) : null}
      {waiting && message.imageGeneration && !showImageJob ? (
        <div className={styles.notice} role="status">
          {t('imageGenerating')}
        </div>
      ) : null}
      {waiting && !message.imageGeneration ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <span>{notice.text}</span>
        </div>
      ) : null}
      {!streaming && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {streaming && !showImageJob ? null : (
        <div className={styles.bottom}>
          <BranchSwitcher
            versions={versions}
            disabled={busy || pendingImageJob}
            onSelect={onSelectVersion}
          />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            {message.status === 'done' ? (
              <IconButton
                icon={<IconShareOutline16 />}
                tooltip={t('conversationShareSystemShare')}
                tooltipPlacement="bottom"
                disabled={busy || shareDisabled}
                onClick={() => onShare(message.id)}
              />
            ) : null}
            {!pendingImageJob && !showImageJob ? (
              <IconButton
                icon={<IconRefreshOutline16 />}
                tooltip={t('regenerate')}
                tooltipPlacement="bottom"
                disabled={busy || refused || (message.imageGeneration === true && !imageProvider)}
                onClick={() => {
                  stopReadAloud()
                  regenerateReply(sessionId, message.id)
                }}
              />
            ) : null}
          </div>
          {isLast && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})

const imageJobLabels = {
  submitting: 'imageRequestSubmitting',
  queued: 'imageBackgroundGenerating',
  running: 'imageBackgroundGenerating',
  completed: 'imageReadingResult',
  recoverable: 'imageConnectionInterrupted',
  cancelling: 'imageStoppingGeneration',
  unknown: 'imageJobUnknown',
  expired: 'imageJobExpired',
  cancelled: 'imageJobCancelled',
  failed: 'imageJobFailed',
} as const

const ImageJobNotice = ({
  sessionId,
  messageId,
  job,
  imageProvider,
  pending,
  busy,
}: {
  sessionId: string
  messageId: string
  job: NonNullable<AssistantMessageType['imageJob']>
  imageProvider: ReturnType<typeof useActiveImageProvider>
  pending: boolean
  busy: boolean
}) => {
  const t = useTranslate()
  const unconfirmedSubmission =
    job.state === 'recoverable' && job.error?.code === 'image_job_not_found' && !job.cancelRequested
  const recoveryLabel = job.cancelRequested
    ? 'imageConfirmStop'
    : unconfirmedSubmission
      ? 'imageContinueSubmitting'
      : 'imageContinueViewing'
  let text = t(imageJobLabels[job.state])
  if (
    job.cancelRequested &&
    ['submitting', 'queued', 'running', 'recoverable'].includes(job.state)
  ) {
    text = t('imageStopUnconfirmed')
  } else if (unconfirmedSubmission) {
    text = t('imageSubmissionUnconfirmed')
  } else if ((job.state === 'failed' || job.error?.code === 'image_batch_incomplete') && job.error?.message) {
    text = job.error.message
  }
  return (
    <div
      className={clsx(styles.imageJob, !pending && styles.imageJobTerminal)}
      role="status"
      aria-live="polite"
    >
      <div className={styles.imageJobStatus}>
        <span
          className={clsx(
            styles.imageJobIcon,
            pending && job.state !== 'recoverable' && styles.imageSpinner
          )}
        >
          {pending ? <IconRefreshOutline16 /> : <IconWarningOutline16 />}
        </span>
        <p>{text}{pending && job.prompts && job.state !== 'recoverable' ? ` (${job.prompts.length})` : ''}</p>
      </div>
      <div className={styles.imageJobActions}>
        {!pending ? (
          <Button
            variant="outlined"
            size="s"
            aria-label={t('regenerate')}
            disabled={busy || !imageProvider}
            onClick={() => {
              stopReadAloud()
              regenerateReply(sessionId, messageId)
            }}
          >
            {t('regenerate')}
          </Button>
        ) : null}
        {job.state === 'recoverable' ? (
          <Button
            variant="outlined"
            size="s"
            disabled={busy || (unconfirmedSubmission && imageProvider !== 'managed')}
            onClick={() => {
              const accepted = unconfirmedSubmission
                ? retryImageJobSubmission(sessionId, messageId)
                : resumeImageJob(sessionId, messageId)
              if (!accepted) {
                showToast(t('imageActionUnavailable'))
              }
            }}
          >
            {t(recoveryLabel)}
          </Button>
        ) : null}
        {pending &&
        job.state !== 'cancelling' &&
        job.state !== 'completed' &&
        (!job.cancelRequested || job.state === 'recoverable') ? (
          <Button
            variant="outlined"
            size="s"
            onClick={() => {
              if (!cancelImageJob(sessionId, messageId)) {
                showToast(t('imageActionUnavailable'))
              }
            }}
          >
            {t(job.cancelRequested ? 'imageRetryStop' : 'imageStopGeneration')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
