import {
  personalEndpoint,
  type PersonalEndpoint,
  DEFAULT_CHAT_MODEL,
  OFFICIAL_BASE,
} from './providerEndpoint.js'
import { configureChatProvider } from './chatProvider.js'
import { syncDocument, type SyncDocument } from './cloudPreferences.js'
import { readPersonalApiKey } from './personalKeyVault.js'
import { getRuntime, isGuestWorkspace, isSessionActive } from './runtime.js'
import { useConversationSync } from './conversationSync.js'

export type KeyEnvelope = { version: 1; salt: string; iv: string; ciphertext: string }
const encoder = new TextEncoder()
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const decode = (text: string, min: number, max = min) => {
  if (typeof text !== 'string' || text.length > 4 * Math.ceil(max / 3)) {
    throw new Error('Invalid envelope')
  }
  const bytes = Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
  if (bytes.length < min || bytes.length > max || encode(bytes) !== text) {
    throw new Error('Invalid envelope')
  }
  return bytes
}
const deriveKey = async (phrase: string, salt: Uint8Array<ArrayBuffer>) => {
  const material = await crypto.subtle.importKey('raw', encoder.encode(phrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}
const validKey = (key: string) => key !== 'server-managed' && /^[\x21-\x7e]{1,4080}$/.test(key)
export async function encryptKey(
  key: string,
  phrase: string,
  endpoint: PersonalEndpoint = personalEndpoint()
): Promise<KeyEnvelope> {
  if (!validKey(key) || phrase.trim().length < 12 || phrase.length > 512) {
    throw new Error('Invalid backup input')
  }
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12))
  const config = personalEndpoint(endpoint.baseUrl, endpoint.model)
  const payload =
    config.baseUrl === OFFICIAL_BASE && config.model === DEFAULT_CHAT_MODEL
      ? key
      : '\0' + JSON.stringify({ apiKey: key, ...config })
  const bytes = encoder.encode(payload)
  if (bytes.length > 4080) {
    throw new Error('Backup too large')
  }
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await deriveKey(phrase, salt),
    bytes
  )
  return {
    version: 1,
    salt: encode(salt),
    iv: encode(iv),
    ciphertext: encode(new Uint8Array(encrypted)),
  }
}
async function decryptCredential(envelope: KeyEnvelope, phrase: string) {
  if (envelope.version !== 1 || !phrase || phrase.length > 512) {
    throw new Error('Invalid envelope')
  }
  const iv = decode(envelope.iv, 12),
    salt = decode(envelope.salt, 16),
    ciphertext = decode(envelope.ciphertext, 17, 4096)
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    await deriveKey(phrase, salt),
    ciphertext
  )
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  const data = text.startsWith('\0') ? JSON.parse(text.slice(1)) : { apiKey: text }
  if (typeof data?.apiKey !== 'string' || !validKey(data.apiKey)) {
    throw new Error('Invalid key')
  }
  return { apiKey: data.apiKey as string, endpoint: personalEndpoint(data.baseUrl, data.model) }
}
export async function decryptKey(envelope: KeyEnvelope, phrase: string): Promise<string> {
  return (await decryptCredential(envelope, phrase)).apiKey
}

export function keyBackupSession(generation: number) {
  const owner = getRuntime().user.id
  const guard = () => {
    const state = useConversationSync.getState()
    if (
      !isSessionActive() ||
      isGuestWorkspace() ||
      getRuntime().user.id !== owner ||
      !state.eligible ||
      !state.enabled ||
      state.generation !== generation
    ) {
      throw new Error('Session changed')
    }
  }
  return {
    async load() {
      guard()
      const result = await syncDocument<KeyEnvelope>('key-envelope', generation)
      guard()
      return result
    },
    async save(revision: number, phrase: string) {
      guard()
      const credential = await readPersonalApiKey()
      if (!credential) {
        throw new Error('No local key')
      }
      const value = await encryptKey(credential.apiKey, phrase, credential)
      guard()
      return syncDocument('key-envelope', generation, { revision, value })
    },
    async restore(doc: SyncDocument<KeyEnvelope>, phrase: string) {
      guard()
      const latest = await this.load()
      if (!latest.value || latest.revision !== doc.revision) {
        throw new Error('Backup changed')
      }
      const credential = await decryptCredential(latest.value, phrase)
      guard()
      await configureChatProvider({ mode: 'personal', ...credential })
    },
    async remove(revision: number) {
      guard()
      return syncDocument<KeyEnvelope>('key-envelope', generation, { revision, value: null })
    },
  }
}
