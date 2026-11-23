import { cancelUpload, useUploads } from './attachments.js'
import { releaseDraftMemory } from './chat/drafts.js'
import { suspendReply, useChatStore } from './chat/store.js'
import { stopReadAloud } from './speech/readAloud.js'

/** Stops all account activity; saved account-scoped history remains intact. */
export const stopSessionActivity = (clearDrafts = false) => {
  for (const id of Object.keys(useChatStore.getState().streaming)) {
    suspendReply(id)
  }
  stopReadAloud()
  window.dispatchEvent(new Event('deepseek-session-ending'))
  if (clearDrafts) {
    releaseDraftMemory()
    for (const id of Object.keys(useUploads.getState().tasks)) {
      cancelUpload(id)
    }
  }
}
