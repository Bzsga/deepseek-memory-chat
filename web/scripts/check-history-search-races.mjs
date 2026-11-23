import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const callbacks = new Set()
const state = { activeId:'search-a', sessions:[], sessionCache:{} }
globalThis.testState = state
globalThis.testSubscribe = callback => {callbacks.add(callback);return () => callbacks.delete(callback)}
let owner = 'owner-a'
let epoch = 0
globalThis.testOwner = () => owner
globalThis.testGuard = expected => {
  const captured = epoch
  return () => expected === owner && captured === epoch
}
globalThis.testPublish = next => {
  Object.assign(state,next)
  for (const subscriber of callbacks) subscriber(state)
}

const mock = value => 'data:text/javascript,' + encodeURIComponent(value)
const db = mock("export const loadSession = (...args) => globalThis.testRead(...args)")
const runtime = mock("export const getRuntime = () => ({user:{id:globalThis.testOwner()}})")
const store = mock(
  "export const captureConversationDataGuard = (...args) => globalThis.testGuard(...args);" +
  "export const useChatStore = { getState: () => globalThis.testState, subscribe: globalThis.testSubscribe };" +
  "export const selectSession = id => globalThis.testPublish({activeId:id});" +
  "export const selectMessageVersion = () => {throw Error('unexpected branch write')};"
)
registerHooks({ resolve(specifier,context,next) {
  if (specifier === './db.js') return next(db,context)
  if (specifier === '../runtime.js') return next(runtime,context)
  if (specifier === './store.js') return next(store,context)
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const source = specifier.slice(0,-3)+'.ts'
    if (existsSync(fileURLToPath(new URL(source,context.parentURL)))) return next(source,context)
  }
  return next(specifier,context)
} })
const { findTitleHits, findMessageHits, searchHistoryBody } = await import('../src/services/chat/historySearch.ts')
const { useChatLocation, openChatLocation, consumeChatLocation } = await import('../src/services/chat/chatLocation.ts')
const summaries = [
  {id:'search-a',title:'İ🧭[Mixed]-/Case',createdAt:1,updatedAt:2},
  {id:'search-b',title:'second',createdAt:1,updatedAt:1},
]
function row(id) {
  return {id,messages:[{role:'user',createdAt:1,id:id+'-message',content:'query-literal'}]}
}
assert.deepEqual(findTitleHits(summaries,'[mixed]-/case','Untitled')[0].title,
  {before:'İ🧭',match:'[Mixed]-/Case',after:''})
assert.equal(findMessageHits([{role:'user',id:'n',createdAt:1,content:'  X \n Y  '}],'x y')[0].match,'X Y')

testPublish({sessions:summaries,sessionCache:{'search-a':row('search-a')}})
let complete
globalThis.testRead = id => new Promise(resolve => {complete=()=>resolve(row(id))})
const aborted = new AbortController()
const searching = searchHistoryBody(summaries,'query-literal',aborted.signal)
assert.equal(typeof complete,'function')
aborted.abort()
complete()
assert.deepEqual(await searching,[])

const oldAccount = searchHistoryBody(summaries,'query-literal',new AbortController().signal)
owner='owner-b'
complete()
assert.deepEqual(await oldAccount,[])

const replaced = searchHistoryBody(summaries,'query-literal',new AbortController().signal)
epoch++
complete()
assert.deepEqual(await replaced,[])

assert.equal(openChatLocation({sessionId:'search-a',messageId:'search-a-message'}),true)
const first = useChatLocation.getState().target
testPublish({activeId:'search-b'})
assert.equal(useChatLocation.getState().target,null)
assert.equal(openChatLocation({sessionId:'search-b',messageId:'search-b-message'}),true)
const second = useChatLocation.getState().target
consumeChatLocation(first)
assert.equal(useChatLocation.getState().target,second)
epoch++
testPublish({})
assert.equal(useChatLocation.getState().target,null)
assert.equal(callbacks.size,0)
assert.equal(openChatLocation({sessionId:'not-an-account-session',messageId:'missing'}),false)
console.log('Local-search races passed: literal/Unicode excerpts, cancelled IDB scan, switched-account and replaced-history isolation, pending jump cancellation.')
