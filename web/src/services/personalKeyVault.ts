/** Account-local encrypted key storage. No conversation/backup store is opened. */
import { personalEndpoint, type PersonalEndpoint } from './providerEndpoint.js'
import { accountStorageKey } from './runtime.js'

type EncryptedCredential = {
  id: 'credential'
  scope: string
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
}
type WrappingKey = { id: 'key'; key: CryptoKey }
export type PersonalCredential = PersonalEndpoint & { apiKey: string; scope: string }
const databases = new Map<string, Promise<IDBDatabase>>()
const encoder = new TextEncoder()
type VaultPurpose = 'chat' | 'image'
const databaseName = (purpose: VaultPurpose) => accountStorageKey(`${purpose}-provider-vault`)
const aad = (purpose: VaultPurpose) => encoder.encode(databaseName(purpose) + ':aes-gcm:v1')
const database = (purpose: VaultPurpose): Promise<IDBDatabase> => {
  const name = databaseName(purpose)
  let current = databases.get(name)
  if (!current) {
    current = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'id' })
      request.onerror = () => reject(new Error('无法打开本机加密凭据存储。'))
      request.onblocked = () => reject(new Error('本机凭据存储正在被其他页面使用，请刷新后重试。'))
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          db.close()
          databases.delete(name)
        }
        resolve(db)
      }
    })
    databases.set(name, current)
    void current.catch(() => databases.delete(name))
  }
  return current
}
const get = <T>(store: IDBObjectStore, key: string): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(new Error('无法读取本机加密凭据。'))
  })
const finish = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(new Error('无法保存本机加密凭据。'))
  })

export const hasPersonalApiKey = async (purpose: VaultPurpose = 'chat'): Promise<boolean> => {
  const db = await database(purpose)
  return (
    (await get<EncryptedCredential>(
      db.transaction('entries').objectStore('entries'),
      'credential'
    )) !== undefined
  )
}
export const readPersonalApiKey = async (
  purpose: VaultPurpose = 'chat'
): Promise<PersonalCredential | null> => {
  const db = await database(purpose)
  const store = db.transaction('entries').objectStore('entries')
  const [record, wrapping] = await Promise.all([
    get<EncryptedCredential>(store, 'credential'),
    get<WrappingKey>(store, 'key'),
  ])
  if (!record) {
    return null
  }
  if (
    !wrapping?.key ||
    wrapping.key.extractable ||
    wrapping.key.algorithm.name !== 'AES-GCM' ||
    !/^personal:[A-Za-z0-9-]{1,128}$/.test(record.scope) ||
    !(record.iv instanceof Uint8Array) ||
    record.iv.byteLength !== 12
  ) {
    throw new Error('本机加密凭据不可用，请重新填写个人 API Key。')
  }
  try {
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: aad(purpose) },
      wrapping.key,
      record.ciphertext
    )
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    // A NUL prefix distinguishes the new record from every valid legacy key.
    if (!text.startsWith('\0')) {
      return { apiKey: text, scope: record.scope, ...personalEndpoint() }
    }
    const { apiKey, baseUrl, model } = JSON.parse(text.slice(1))
    if (typeof apiKey !== 'string') {
      throw new Error('Invalid credential')
    }
    return { apiKey, scope: record.scope, ...personalEndpoint(baseUrl, model) }
  } catch {
    throw new Error('本机加密凭据无法解密，请重新填写个人 API Key。')
  }
}
export const storePersonalApiKey = async (
  apiKey: string,
  endpoint: PersonalEndpoint = personalEndpoint(),
  purpose: VaultPurpose = 'chat'
): Promise<PersonalCredential> => {
  const db = await database(purpose)
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(purpose) },
    key,
    encoder.encode(
      endpoint.baseUrl === personalEndpoint().baseUrl && endpoint.model === personalEndpoint().model
        ? apiKey
        : '\0' + JSON.stringify({ apiKey, ...endpoint })
    )
  )
  const scope = 'personal:' + crypto.randomUUID()
  const tx = db.transaction('entries', 'readwrite')
  const completed = finish(tx)
  tx.objectStore('entries').put({ id: 'key', key } satisfies WrappingKey)
  tx.objectStore('entries').put({
    id: 'credential',
    scope,
    iv,
    ciphertext,
  } satisfies EncryptedCredential)
  await completed
  return { apiKey, scope, ...endpoint }
}
export const removePersonalApiKey = async (purpose: VaultPurpose = 'chat'): Promise<void> => {
  const db = await database(purpose)
  const tx = db.transaction('entries', 'readwrite')
  const completed = finish(tx)
  tx.objectStore('entries').clear()
  await completed
}
