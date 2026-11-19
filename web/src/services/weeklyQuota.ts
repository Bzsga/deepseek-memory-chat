import { updateManagedEligibility } from './chatProvider.js'
import { create } from 'zustand'
import {
  fetchRuntime,
  getRuntime,
  invalidateSession,
  isGuestWorkspace,
  LoginRequired,
  type WeeklyQuota,
} from './runtime.js'

export const useWeeklyQuota = create<{ quota?: WeeklyQuota }>(() => ({
  quota: getRuntime().weekly_quota,
}))
// An older refresh must not undo a completed redemption.
let revision = 0
export const applyRedeemedQuota = (quota: WeeklyQuota) => {
  revision++
  updateManagedEligibility(true)
  useWeeklyQuota.setState({ quota })
}
let pending: Promise<void> | undefined
export const refreshWeeklyQuota = (): Promise<void> => {
  if (isGuestWorkspace()) {return Promise.resolve()}
  if (pending) {
    return pending
  }
  const started = revision
  pending = fetchRuntime()
    .then((fresh) => {
      if (fresh.user.id !== getRuntime().user.id) {
        invalidateSession('changed')
      } else if (started === revision) {
        updateManagedEligibility(fresh.user.managed_eligible)
        useWeeklyQuota.setState({ quota: fresh.weekly_quota })
      }
    })
    .catch((error: unknown) => {
      if (error instanceof LoginRequired) {
        invalidateSession('login')
      }
    })
    .finally(() => {
      pending = undefined
    })
  return pending
}
export const bindWeeklyQuotaRefresh = () => {
  if (isGuestWorkspace()) {return}
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void refreshWeeklyQuota(), 250)
  }
  const visibility = () => {
    if (document.visibilityState === 'visible') {
      refresh()
    }
  }
  window.addEventListener('deepseek:usage', refresh)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', visibility)
  const resetTimer = setInterval(() => {
    const reset = useWeeklyQuota.getState().quota?.reset_at
    if (reset && Date.parse(reset) <= Date.now() && document.visibilityState === 'visible') {
      refresh()
    }
  }, 60000)
  return () => {
    clearTimeout(timer)
    clearInterval(resetTimer)
    window.removeEventListener('deepseek:usage', refresh)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', visibility)
  }
}
