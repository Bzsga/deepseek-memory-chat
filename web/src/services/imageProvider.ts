import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import { getRuntime, isSessionActive, subscribeRuntimeUser } from './runtime.js'
import { readPersonalApiKey, storePersonalApiKey } from './personalKeyVault.js'
import { normalizeProviderBase, providerApiUrl, fetchProviderModels, readProviderModels } from './providerEndpoint.js'
import { nativePersonalImageChannel } from './nativeBridge.js'
import { requestNativePersonalImage } from './nativePersonalImage.js'
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
export const managedImageAvailable = () => isSessionActive() && getRuntime().user.permissions.image_api && getRuntime().features.image_generation === true
export const useManagedImageAvailable = () => useSyncExternalStore(subscribeRuntimeUser, managedImageAvailable)
export const activeImageProvider = (): 'personal' | 'managed' | null => {
  if (!isSessionActive() || !useImageProvider.getState().ready) {return null}
  if (saved.mode === 'personal') {return saved.key && saved.model && saved.base ? 'personal' : null}
  return saved.mode === 'managed' && managedImageAvailable() ? 'managed' : null
}
const subscribeImageAvailability = (listener: () => void) => {
  const unsubscribeImage = useImageProvider.subscribe(listener)
  const unsubscribeEligibility = subscribeRuntimeUser(listener)
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
const browserImageRequest = async <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    if (error instanceof TypeError && !signal?.aborted) {
      throw new Error('无法连接个人生图服务。请检查地址和网络，网页和旧版 App 还需要服务商允许跨域访问。')
    }
    throw error
  }
}
export const imageModels = async (base: string, key: string, signal?: AbortSignal) => {
  const c = credentials(base, key)
  const channel = nativePersonalImageChannel()
  if (channel) {
    const value = await requestNativePersonalImage(channel, {
      operation: 'models', url: providerApiUrl(c.base, 'models'), key: c.key,
    }, isSessionActive, signal)
    return readProviderModels(value)
  }
  return browserImageRequest(() => fetchProviderModels(c.base, c.key, signal), signal)
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
function personalImageItem(value: unknown) {
  const result = value as { data?: { b64_json?: string; url?: string }[] } | null
  if (!Array.isArray(result?.data) || result.data.length !== 1 || !result.data[0]) {
    throw new Error('个人生图服务没有返回单张图片。')
  }
  return result.data[0]
}

export const requestPersonalImage = async (prompt: string, signal: AbortSignal, sources?: readonly File[]) => {
  if (activeImageProvider() !== 'personal') {throw new Error('个人生图服务已关闭或配置不完整。')}
  const { base, key, model } = saved
  if (sources?.length === 0) {throw new Error('请至少选择一张参考图。')}
  const url = providerApiUrl(base, sources ? 'images/edits' : 'images/generations')
  const channel = nativePersonalImageChannel()
  if (channel) {
    const config = configurationId
    const result = await requestNativePersonalImage(channel, {
      operation: sources ? 'edit' : 'generate', url, key, model, prompt, files: sources,
    }, () => config === configurationId && isSessionActive(), signal)
    return { model, images: [decodePersonalImage(personalImageItem(result))] }
  }
  const headers = new Headers({ Authorization: `Bearer ${key}` })
  let body: BodyInit
  if (sources) {
    const form = new FormData()
    form.set('model', model)
    form.set('prompt', prompt)
    form.set('n', '1')
    const field = sources.length === 1 ? 'image' : 'image[]'
    for (const source of sources) {form.append(field, source)}
    body = form
  } else {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify({ model, prompt, n: 1 })
  }
  const response = await browserImageRequest(() => fetch(url, {
    method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers,
    body,
  }), signal)
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (sources && [404, 405, 501].includes(response.status)) {
      throw new Error(`个人生图服务的图片编辑接口不可用（HTTP ${response.status}）。请检查服务地址及模型是否支持图片编辑。`)
    }
    throw new Error(sources
      ? `个人生图服务未能编辑图片（HTTP ${response.status}）。请检查服务配置、模型和参考图。`
      : `个人生图服务返回 HTTP ${response.status}。`)
  }
  const item = personalImageItem(await readJson(response, 29 * 1024 * 1024))
  if (item.b64_json) {return { model, images: [decodePersonalImage(item)] }}
  if (!item.url) {throw new Error('个人生图服务没有返回图像数据。')}
  const resultUrl = new URL(item.url)
  if (resultUrl.protocol !== 'https:' || resultUrl.username || resultUrl.password) {throw new Error('个人生图结果地址无效。')}
  const image = await browserImageRequest(() => fetch(resultUrl.href, {
    credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
  }), signal)
  if (!image.ok) {throw new Error('个人生图结果下载失败。')}
  return { model, images: [await decodePersonalImageResponse(image)] }
}
