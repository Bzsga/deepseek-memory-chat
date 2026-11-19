import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import { getRuntime, isSessionActive } from './runtime.js'
import { useChatProvider } from './chatProvider.js'
import { readPersonalApiKey, storePersonalApiKey } from './personalKeyVault.js'
import { normalizeProviderBase, providerApiUrl, fetchProviderModels } from './providerEndpoint.js'
import { readJson } from './api/imageJobs.js'
import { decodePersonalImage, decodePersonalImageResponse } from './chat/imageGeneration.js'

type Mode = 'personal' | 'managed' | 'off'
type Config = { mode: Mode; base: string; model: string; key: string }
const defaults: Config = { mode: 'managed', base: '', model: '', key: '' }
let configurationId = Symbol()
let saved = defaults
let loading: Promise<void> | undefined
export const useImageProvider = create(() => ({ mode: 'managed' as Mode, base: '', model: '', configured: false, ready: false }))
const publish = (config: Config) => {
  saved = config
  configurationId = Symbol()
  useImageProvider.setState({ mode: config.mode, base: config.base, model: config.model, configured: !!config.key, ready: true })
}
export const initializeImageProvider = () => loading ??= (async () => {
  try {
    const entry = await readPersonalApiKey('image')
    publish(entry ? JSON.parse(entry.apiKey) as Config : defaults)
  } catch { publish({ ...defaults, mode: 'off' }) }
})()
export const imageConfigurationIdentity = () => activeImageProvider() === 'personal' ? configurationId : activeImageProvider()
export const managedImageAvailable = () => isSessionActive() && useChatProvider.getState().managedEligible && getRuntime().features.image_generation === true
export const activeImageProvider = (): 'personal' | 'managed' | null => {
  if (!isSessionActive() || !useImageProvider.getState().ready) {return null}
  if (saved.mode === 'personal') {return saved.key && saved.model && saved.base ? 'personal' : null}
  return saved.mode === 'managed' && managedImageAvailable() ? 'managed' : null
}
const subscribeImageAvailability = (listener: () => void) => {
  const unsubscribeImage = useImageProvider.subscribe(listener)
  const unsubscribeEligibility = useChatProvider.subscribe(listener)
  return () => {unsubscribeImage(); unsubscribeEligibility()}
}
export const useActiveImageProvider = () => useSyncExternalStore(subscribeImageAvailability, activeImageProvider)
const credentials = (input: string, key: string) => {
  if (!input.trim()) {throw new Error('请填写生图服务的 Base URL。')}
  const base = normalizeProviderBase(input)
  const secret = key.trim() || (saved.base === base ? saved.key : '')
  if (!secret || secret.length > 8192 || !/^[\x21-\x7e]+$/.test(secret)) {throw new Error('请为此地址填写有效的生图 API Key。')}
  return { base, key: secret }
}
export const imageModels = (base: string, key: string, signal?: AbortSignal) => {
  const c = credentials(base, key)
  return fetchProviderModels(c.base, c.key, signal)
}
export const configureImageProvider = async (mode: Mode, input: string, key: string, model: string) => {
  await initializeImageProvider()
  if (!isSessionActive()) {throw new Error('账号已变化，请重新打开页面。')}
  let config = { ...saved, mode }
  if (mode === 'personal') {
    if (!model.trim() || model.trim().length > 128) {throw new Error('请填写生图模型。')}
    config = { mode, model: model.trim(), ...credentials(input, key) }
  }
  if (mode === 'managed' && !managedImageAvailable()) {throw new Error('此账号当前没有可用的配套生图服务。')}
  await storePersonalApiKey(JSON.stringify(config), undefined, 'image')
  publish(config)
}
export const forgetImageProvider = async () => {
  const config: Config = { ...defaults, mode: 'off' }
  await storePersonalApiKey(JSON.stringify(config), undefined, 'image')
  publish(config)
}
export const requestPersonalImage = async (prompt: string, signal: AbortSignal) => {
  if (activeImageProvider() !== 'personal') {throw new Error('个人生图服务已关闭或配置不完整。')}
  const { base, key, model } = saved
  const response = await fetch(providerApiUrl(base, 'images/generations'), {
    method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, n: 1 }),
  })
  if (!response.ok) {throw new Error(`个人生图服务返回 HTTP ${response.status}。`)}
  const result = await readJson(response, 29 * 1024 * 1024) as { data?: { b64_json?: string; url?: string }[] }
  const item = result?.data?.[0]
  if (!item || result.data?.length !== 1) {throw new Error('个人生图服务没有返回单张图片。')}
  if (item.b64_json) {return { model, images: [decodePersonalImage(item)] }}
  if (!item.url) {throw new Error('个人生图服务没有返回图像数据。')}
  const url = new URL(item.url)
  if (url.protocol !== 'https:' || url.username || url.password) {throw new Error('个人生图结果地址无效。')}
  const image = await fetch(url.href, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal })
  if (!image.ok) {throw new Error('个人生图结果下载失败。')}
  return { model, images: [await decodePersonalImageResponse(image)] }
}
