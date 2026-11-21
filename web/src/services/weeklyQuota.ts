import { create } from 'zustand'
import {
  getRuntime,
  initializeRuntime,
  isGuestWorkspace,
  refreshRuntime,
  subscribeRuntimeUser,
  type RuntimeUser,
  type WeeklyQuota,
} from './runtime.js'

export const useWeeklyQuota = create<{ quota?: WeeklyQuota }>(() => ({
  quota: getRuntime().weekly_quota,
}))
subscribeRuntimeUser(() => useWeeklyQuota.setState({ quota: getRuntime().weekly_quota }))
export const applyInviteRedemption = (user: RuntimeUser, quota?: WeeklyQuota) => {
  initializeRuntime({ ...getRuntime(), user, weekly_quota: quota })
}
export const refreshWeeklyQuota = (): Promise<void> =>
  isGuestWorkspace() ? Promise.resolve() : refreshRuntime()
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
