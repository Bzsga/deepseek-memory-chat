export type SharedConversationSource = {
  kind: 'deepseek-share' | 'app-share'
  shareId: string
  url: string
  scope: 'shared_snapshot'
  importedAt: number
  rawSnapshot: string
  /** Original shared nodes, before any new local conversation branches. */
  messageIds?: string[]
}

export const MAX_SHARED_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAX_APP_SHARED_SNAPSHOT_BYTES = 16 * 1024 * 1024

export const validateSharedSource = (value: unknown): SharedConversationSource => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('分享来源资料无效。')
  }
  const source = value as Partial<SharedConversationSource>
  let url: URL
  try {
    url = new URL(source.url ?? '')
  } catch {
    throw new Error('分享来源地址无效。')
  }
  if (
    !['deepseek-share', 'app-share'].includes(source.kind ?? '') ||
    source.scope !== 'shared_snapshot' ||
    typeof source.shareId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(source.shareId) ||
    (source.kind === 'app-share' && !/^[A-Za-z0-9_-]{32,128}$/.test(source.shareId)) ||
    typeof source.url !== 'string' ||
    source.url.length > 2048 ||
    url.protocol !== 'https:' ||
    (source.kind === 'deepseek-share' ? url.hostname !== 'chat.deepseek.com' :
      (url.hostname !== 'digimonlegend.com' || url.pathname !== `/deepseek/share/${source.shareId}` || url.search || url.hash)) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    typeof source.importedAt !== 'number' ||
    !Number.isFinite(source.importedAt) ||
    source.importedAt < 0 ||
    typeof source.rawSnapshot !== 'string' ||
    new TextEncoder().encode(source.rawSnapshot).byteLength > (source.kind === 'app-share' ? MAX_APP_SHARED_SNAPSHOT_BYTES : MAX_SHARED_SNAPSHOT_BYTES) ||
    (source.messageIds !== undefined &&
      (!Array.isArray(source.messageIds) ||
        source.messageIds.length > 50000 ||
        source.messageIds.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
        new Set(source.messageIds).size !== source.messageIds.length))
  ) {
    throw new Error('分享来源资料无效。')
  }
  return {
    kind: source.kind as SharedConversationSource['kind'],
    shareId: source.shareId,
    url: source.url,
    scope: 'shared_snapshot',
    importedAt: source.importedAt,
    rawSnapshot: source.rawSnapshot,
    ...(source.messageIds ? { messageIds: [...source.messageIds] } : {}),
  }
}

export const remapSharedSource = (
  source: SharedConversationSource,
  mapId: (id: string) => string | undefined
): SharedConversationSource =>
  validateSharedSource({
    ...source,
    ...(source.messageIds
      ? {
          messageIds: source.messageIds.map((id) => {
            const mapped = mapId(id)
            if (!mapped) {
              throw new Error('分享来源引用了缺失的消息。')
            }
            return mapped
          }),
        }
      : {}),
  })
