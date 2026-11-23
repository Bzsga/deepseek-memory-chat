import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

let owner = 'synthetic-owner'
let active = true
const requests = []
const appended = new Map([['existing-chat', { id: 'existing-chat' }]])
let requestHandler
globalThis.__shareRequest = async (url, init) => {
  requests.push({ url, method: init.method })
  assert.match(url, /^\/deepseek-api\/chat\/api\/shared-conversation\?share_id=[A-Za-z0-9_-]+$/)
  assert.equal(init.method, 'GET')
  return requestHandler(url, init)
}
globalThis.__shareRuntime = () => ({ user: { id: owner } })
globalThis.__shareActive = () => active
globalThis.__shareStore = async () => ({
  appendImportedSession: async (session, expectedOwner) => {
    assert.equal(owner, expectedOwner)
    assert.ok(active)
    if (!appended.has(session.id)) appended.set(session.id, structuredClone(session))
    return session.id
  },
})

const path = new URL('../src/services/sharedConversation.ts', import.meta.url)
let source = stripTypeScriptTypes(readFileSync(path, 'utf8'))
source = source
  .replace(
    "import { createId } from '../utils/id.js'",
    'const createId = () => crypto.randomUUID()'
  )
  .replace(
    "import { API_ORIGIN, getRuntime, isSessionActive } from './runtime.js'",
    "const API_ORIGIN = '/deepseek-api/chat'; const getRuntime = () => globalThis.__shareRuntime(); const isSessionActive = () => globalThis.__shareActive()"
  )
  .replace("await import('./api/client.js')", 'await Promise.resolve({request:(...args)=>globalThis.__shareRequest(...args)})')
  .replace("await import('./chat/store.js')", 'await globalThis.__shareStore()')
const share = await import(`data:text/javascript,${encodeURIComponent(source)}`)
const link = { shareId: 'abc123', url: 'https://chat.deepseek.com/share/abc123' }
const text = JSON.stringify({
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      title: '合成分享',
      messages: [
        {
          id: 1,
          role: 'USER',
          inserted_at: '2026-11-17T00:00:00Z',
          fragments: [
            { type: 'REQUEST', content: '  保留原话。\n还有一行。  ' },
            {
              type: 'FILE',
              files: [{ file_id: 'foreign-account-file', file_name: '合成.png', is_image: true }],
            },
          ],
        },
        {
          id: 2,
          role: 'ASSISTANT',
          fragments: [
            { type: 'THINK', content: '合成思考不入正文' },
            { type: 'SEARCH', content: '搜索过程不入正文', queries: ['合成搜索'], results: [] },
            { type: 'TOOL_SEARCH', queries: ['合成工具搜索'], results: [] },
            { type: 'RESPONSE', content: '原始回答' },
          ],
        },
        { id: 3, role: 'USER', content: '未回答的问题' },
      ],
    },
  },
})
const parsed = share.parseSharedConversationSnapshot(text, link, 12345)
assert.equal(parsed.session.messages[0].content, '  保留原话。\n还有一行。  ')
assert.equal(parsed.session.messages[0].files[0].serverId, null)
assert.equal(parsed.session.messages[0].files[0].isImage, true)
assert.equal(parsed.session.messages[1].blocks[0].text, '原始回答')
assert.equal(parsed.visibleMessages[1].content, '原始回答')
assert.equal(parsed.session.messages[2].content, '未回答的问题')
assert.equal(parsed.session.sharedSource.rawSnapshot, text)
assert.equal(parsed.session.messages[0].createdAt, Date.parse('2026-11-17T00:00:00Z'))
assert.ok(parsed.warnings.some((warning) => warning.includes('附件')))
assert.ok(parsed.warnings.some((warning) => warning.includes('推理过程')))

for (const input of [
  link.url,
  `这是分享「标题」 ${link.url}。`,
  `${link.url}?a=b#fragment`,
  `${link.url} ${link.url}`,
]) {
  assert.deepEqual(share.parseDeepSeekShareLink(input), link)
}
for (const input of [
  'http://chat.deepseek.com/share/abc123',
  'https://chat.deepseek.com.evil.invalid/share/abc123',
  'https://user@chat.deepseek.com/share/abc123',
  'https://chat.deepseek.com:444/share/abc123',
  'https://chat.deepseek.com/other/../share/abc123',
  'https://chat.deepseek.com\\share\\abc123',
  `${link.url} https://chat.deepseek.com/share/def456`,
  '仅有文字',
])
  assert.throws(() => share.parseDeepSeekShareLink(input))

const branch = share.parseSharedConversationSnapshot(
  JSON.stringify({
    current_message_id: 3,
    messages: [
      { id: 1, parent_id: null, role: 'user', content: '共同问题' },
      { id: 2, parent_id: 1, role: 'assistant', content: '版本一' },
      { id: 3, parent_id: 1, role: 'assistant', content: '版本二' },
    ],
  }),
  link
)
assert.equal(branch.session.messages.length, 3)
assert.deepEqual(
  branch.visibleMessages.map((message) => message.content),
  ['共同问题', '版本二']
)
assert.equal(branch.session.messages[1].parentId, branch.session.messages[0].id)
const partial = share.parseSharedConversationSnapshot(
  JSON.stringify({
    messages: [
      { id: 1, parent_id: 99, role: 'assistant', content: '只有分享的回答' },
      { id: 2, parent_id: null, role: 'user', content: '独立提问' },
    ],
  }),
  link
)
assert.equal(partial.session.messages[0].role, 'assistant')
assert.equal(partial.session.messages[0].parentId, null)
assert.equal(partial.session.messages[1].parentId, null)
assert.ok(partial.warnings.some((warning) => warning.includes('父节点')))
const sameRole = share.parseSharedConversationSnapshot(
  JSON.stringify({
    messages: [
      { role: 'user', content: '第一条' },
      { role: 'user', content: '第二条' },
    ],
  }),
  link
)
assert.equal(sameRole.session.messages[1].parentId, sameRole.session.messages[0].id)

for (const invalid of [
  '{"messages":[],"messages":[{}]}',
  JSON.stringify({ has_more: true, messages: [{ role: 'user', content: '部分' }] }),
  JSON.stringify({
    messages: [{ role: 'user', fragments: [{ type: 'FUTURE_BODY', content: '合成' }] }],
  }),
  JSON.stringify({
    messages: [{ role: 'user', fragments: [{ type: 'RESPONSE', content: '冲突' }] }],
  }),
  JSON.stringify({ messages: [{ content: '没有角色' }] }),
  JSON.stringify({
    messages: [
      { id: 1, role: 'user', content: 'a' },
      { id: 1, role: 'assistant', content: 'b' },
    ],
  }),
  JSON.stringify({
    messages: [
      { id: 1, parent_id: 2, role: 'user', content: 'a' },
      { id: 2, parent_id: 1, role: 'assistant', content: 'b' },
    ],
  }),
  JSON.stringify({
    messages: [
      { id: 1, children: [3], role: 'user', content: 'a' },
      { id: 2, children: [3], role: 'user', content: 'b' },
      { id: 3, role: 'assistant', content: 'c' },
    ],
  }),
  '['.repeat(65) + ']'.repeat(65),
])
  assert.throws(() => share.parseSharedConversationSnapshot(invalid, link))

requestHandler = async () => new Response(text, { headers: { 'Content-Type': 'application/json' } })
const preview = await share.readSharedConversation(`分享文案 ${link.url}。`)
assert.equal(appended.size, 1, 'Reading a share must not write local history')
assert.equal(preview.messageCount, 3)
assert.match(preview.rangeWarning, /分享范围/)
const firstId = await share.continueSharedConversation(preview)
const duplicateId = await share.continueSharedConversation(preview)
assert.equal(firstId, duplicateId)
assert.equal(appended.size, 2)
assert.equal(appended.get(firstId).sharedSource.rawSnapshot, text)
assert.ok(appended.has('existing-chat'))
assert.equal(requests.length, 1, 'Preview confirmation must not fetch or call a model')
owner = 'another-owner'
await assert.rejects(share.continueSharedConversation(preview), /账号/)
owner = 'synthetic-owner'

const aborted = new AbortController()
aborted.abort()
await assert.rejects(share.readSharedConversation(link.url, aborted.signal))
assert.equal(requests.length, 1, 'Already-cancelled reads must not reach the network')

let externalCancelled = false
requestHandler = async (_url, init) =>
  new Response(
    new ReadableStream({
      start(controller) {
        init.signal.addEventListener(
          'abort',
          () => {
            externalCancelled = true
            controller.error(init.signal.reason)
          },
          { once: true }
        )
      },
    })
  )
const pending = share.readSharedConversation(link.url)
await new Promise((resolve) => setTimeout(resolve, 20))
active = false
await assert.rejects(pending, /账号/)
assert.ok(externalCancelled)
assert.equal(appended.size, 2)
active = true

requestHandler = async () => new Response(new Uint8Array([0xc3, 0x28]))
await assert.rejects(share.readSharedConversation(link.url))
requestHandler = async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))
await assert.rejects(share.readSharedConversation(link.url), /8 MB/)
console.log(
  'Shared conversation parsing, preview, append, cancellation and account isolation passed'
)
