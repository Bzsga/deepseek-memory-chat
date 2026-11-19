import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const until = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await sleep(5)
  }
  throw Error('Session bootstrap check timed out')
}

if (process.argv[2] === '--case') {
  const directory = process.argv[3]
  const scenario = process.argv[4]
  const state = { starts: 0, stops: 0, guests: 0, reloads: 0 }
  globalThis.__sessionRefreshTest = state
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  class Element extends EventTarget {
    style = {}
    hidden = false
    children = []
    textContent = ''
    className = ''
    setAttribute() {}
    append(...children) { this.children.push(...children) }
    replaceChildren(...children) { this.children = children }
  }
  const rootElement = new Element()
  const body = new Element()
  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: 'visible', body,
    getElementById: () => rootElement,
    createElement: () => new Element(),
  })
  const location = { origin: 'https://digimonlegend.com', pathname: '/deepseek/', href: 'https://digimonlegend.com/deepseek/',
    reload: () => { state.reloads += 1 } }
  globalThis.location = location
  globalThis.window = Object.assign(new EventTarget(), { location })
  window.top = window
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } })
  globalThis.BroadcastChannel = class { postMessage() {}; close() {} }
  const runtime = { provider: 'DeepSeek', model: 'synthetic',
    features: { search: false, files: false, speech: false },
    user: { id: 'owner-a', username: 'synthetic', role: 'user' } }
  let calls = 0
  const waiting = []
  const response = (value = runtime, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  })
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return scenario === 'guest' ? response({}, 401) : response()
    return new Promise((resolveRequest, reject) => waiting.push({ resolve: resolveRequest, reject }))
  }
  await import(pathToFileURL(join(directory, 'src/main.js')))
  const status = body.children[0]
  if (scenario === 'guest') {
    await until(() => state.starts === 1)
    const { isGuestWorkspace, accountStorageKey } = await import(pathToFileURL(join(directory, 'src/services/runtime.js')))
    assert.equal(isGuestWorkspace(), true)
    assert.ok(accountStorageKey('chats').includes(':local-guest:'))
    assert.equal(rootElement.style.visibility, '')
    assert.equal(status.hidden, true)
    assert.equal(calls, 1)
    window.dispatchEvent(new Event('focus'))
    waiting.shift().resolve(response({}, 401))
    await sleep(10)
    assert.equal(state.reloads, 0)
    window.dispatchEvent(new Event('focus'))
    waiting.shift().resolve(response())
    await until(() => state.reloads === 1)
    process.exit(0)
  }
  await until(() => state.starts === 1 && status.hidden)
  const controller = new AbortController()
  state.activeRequest = controller
  const draft = { text: '未发送的合成草稿', selectedSession: 'synthetic-session' }
  rootElement.draft = draft

  // Android WebView can deliver focus between touch-down and click. The
  // mounted page must still receive that first click while fetch is pending.
  window.dispatchEvent(new Event('focus'))
  assert.equal(waiting.length, 1)
  assert.equal(rootElement.style.visibility, '')
  assert.equal(status.hidden, true)
  let drawerOpen = false
  if (rootElement.style.visibility !== 'hidden' && status.hidden) drawerOpen = true
  assert.equal(drawerOpen, true)
  waiting.shift().resolve(response())
  await sleep(10)
  assert.equal(rootElement.draft, draft)
  assert.equal(state.starts, 1)
  assert.equal(state.stops, 0)
  assert.equal(controller.signal.aborted, false)

  document.visibilityState = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(rootElement.style.visibility, '')
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  const shown = new Event('pageshow')
  shown.persisted = true
  window.dispatchEvent(shown)
  assert.equal(waiting.length, 1)
  assert.equal(rootElement.draft, draft)
  assert.equal(status.hidden, true)
  waiting.shift().reject(new TypeError('synthetic temporary network failure'))
  await sleep(10)
  assert.equal(rootElement.style.visibility, '')
  assert.equal(status.hidden, true)
  assert.equal(state.starts, 1)
  assert.equal(state.stops, 0)
  assert.equal(controller.signal.aborted, false)

  window.dispatchEvent(new Event('focus'))
  const check = waiting.shift()
  if (scenario === 'valid') {
    check.resolve(response())
    await sleep(10)
    assert.equal(rootElement.draft, draft)
    assert.equal(state.reloads, 0)
    assert.equal(state.stops, 0)
  } else {
    if (scenario === 'expired') check.resolve(response({}, 401))
    if (scenario === 'changed') check.resolve(response({ ...runtime, user: { ...runtime.user, id: 'owner-b' } }))
    if (scenario === 'role') check.resolve(response({ ...runtime, user: { ...runtime.user, role: 'admin' } }))
    await until(() => state.reloads === 1)
    assert.equal(state.stops, 1)
    assert.equal(rootElement.style.visibility, 'hidden')
    assert.equal(status.hidden, false)
    assert.equal(controller.signal.aborted, true)
    const { getRuntime, isSessionActive } = await import(pathToFileURL(join(directory, 'src/services/runtime.js')))
    assert.equal(getRuntime().user.id, 'owner-a')
    assert.equal(isSessionActive(), false)
  }
} else {
  const output = mkdtempSync(join(root, '.session-refresh-check-'))
  try {
    const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
      '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--outDir', output],
    { cwd: root, encoding: 'utf8' })
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
    const entry = join(output, 'src/main.js')
    writeFileSync(entry, readFileSync(entry, 'utf8').replace("import './app/bootstrap.css';", ''))
    writeFileSync(join(output, 'src/app/start.js'), `
      export const startApp = () => { globalThis.__sessionRefreshTest.starts += 1 };
      export const stopAppSession = () => {
        globalThis.__sessionRefreshTest.stops += 1;
        globalThis.__sessionRefreshTest.activeRequest?.abort();
      };
    `)
    for (const scenario of ['valid', 'expired', 'changed', 'role', 'guest']) {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--case', output, scenario], {
        cwd: root, encoding: 'utf8', timeout: 10000,
      })
      assert.equal(result.status, 0, `${scenario}\n${result.stdout}\n${result.stderr}`)
    }
    console.log('Session refresh checks passed: first-click availability, shared in-flight focus/resume/BFCache checks, stable draft/page and active request through valid or transient checks, expiry/owner/role invalidation, and guest bootstrap. Synthetic DOM and network only.')
  } finally {
    if (!output.startsWith(root + sep)) throw Error('Unexpected temporary output')
    rmSync(output, { recursive: true, force: true })
  }
}
