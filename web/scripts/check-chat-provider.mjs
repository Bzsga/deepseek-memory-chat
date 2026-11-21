import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '../build/qa/chat-provider')
mkdirSync(output, { recursive: true })
const temporary = mkdtempSync(join(root, '.chat-provider-check-'))
const bundle = join(temporary, 'bundle')
const profile = mkdtempSync(join(tmpdir(), 'deepseek-provider-check-'))
const report = {
  evidence:
    'Real isolated Chromium IndexedDB/WebCrypto; production source bundled only into a temporary regression directory. Model/API fetches are local synthetic functions; DNS blocked and every actual request locally fulfilled.',
  cases: [],
  blocked: [],
  passed: false,
  networkCalls: 0,
  modelCalls: 0,
}
let browser, socket
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const waitFor = async (check, code) => {
  for (let index = 0; index < 250; index++) {
    const value = await check()
    if (value) return value
    await pause(100)
  }
  throw Error(code)
}
try {
  const compiler = rspack({
    mode: 'production',
    context: root,
    entry: join(root, 'scripts/fixtures/chat-provider-entry.mjs'),
    output: {
      path: bundle,
      filename: 'main.js',
      chunkFilename: '[id].js',
      publicPath: '/qa/',
      clean: true,
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.mjs'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    },
    module: {
      rules: [
        {
          test: /\.[cm]?[jt]sx?$/,
          exclude: /[\\/]node_modules[\\/]/,
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic' } },
            },
            env: { targets: ['chrome >= 120'] },
          },
        },
      ],
    },
    plugins: [new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify('/deepseek-api/chat') })],
    performance: { hints: false },
  })
  const stats = await new Promise((resolveRun, reject) =>
    compiler.run((error, stats) => (error ? reject(error) : resolveRun(stats)))
  )
  await new Promise((done) => compiler.close(done))
  assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }))
  const assets = new Map(
    readdirSync(bundle, { recursive: true })
      .filter((name) => statSync(join(bundle, name)).isFile())
      .map((name) => [name.replaceAll('\\', '/'), readFileSync(join(bundle, name))])
  )
  browser = spawn(
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=0',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
  await waitFor(() => existsSync(join(profile, 'DevToolsActivePort')), 'browser_start_timeout')
  const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  socket = new WebSocket(pages.find((item) => item.type === 'page').webSocketDebuggerUrl)
  await new Promise((done) => socket.addEventListener('open', done, { once: true }))
  let sequence = 0
  const pending = new Map()
  const call = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence
      pending.set(id, { resolve: resolveCall, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(event.data)
    if (value.id) {
      const task = pending.get(value.id)
      pending.delete(value.id)
      if (task) value.error ? task.reject(value.error) : task.resolve(value.result)
    } else if (value.method === 'Fetch.requestPaused') {
      void (async () => {
        const params = value.params,
          url = new URL(params.request.url)
        let body,
          mime = 'text/javascript',
          status = 200
        if (
          params.request.method === 'GET' &&
          url.origin === 'https://qa.invalid' &&
          url.pathname === '/test'
        ) {
          body = Buffer.from(
            '<!doctype html><meta charset="utf-8"><script defer src="/qa/main.js"></script>'
          )
          mime = 'text/html; charset=utf-8'
        } else if (
          params.request.method === 'GET' &&
          url.origin === 'https://qa.invalid' &&
          url.pathname.startsWith('/qa/') &&
          assets.has(url.pathname.slice(4))
        )
          body = assets.get(url.pathname.slice(4))
        else if (url.pathname === '/favicon.ico') {
          body = Buffer.alloc(0)
          status = 204
        } else {
          report.blocked.push({
            method: params.request.method,
            origin: url.origin,
            path: url.pathname,
          })
          body = Buffer.from('Blocked')
          status = 403
        }
        await call('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: status,
          responseHeaders: [{ name: 'content-type', value: mime }],
          body: body.toString('base64'),
        })
      })().catch((error) => {
        report.browserHarnessError = error.constructor.name
      })
    }
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  let scope
  for (const scenario of ['main', 'reload', 'corrupt', 'other', 'guest', 'guest-copy']) {
    await call('Page.navigate', { url: 'https://qa.invalid/test?case=' + scenario })
    const result = await waitFor(
      () => evaluate('window.__chatProviderCheck'),
      'scenario_timeout_' + scenario
    )
    report.cases.push(result)
    assert.equal(result.passed, true, JSON.stringify(result))
    if (scenario === 'main') scope = result.scope
    if (scenario === 'reload')
      assert.equal(result.scope, scope, 'Encrypted credential scope must persist across reload')
  }
  assert.equal(report.blocked.length, 0, JSON.stringify(report.blocked))
  report.passed = true
} catch (error) {
  report.failure = String(error)
  process.exitCode = 1
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close()
  browser?.kill()
  await pause(700)
  try {
    assert.equal(dirname(temporary), root)
    assert.ok(temporary.startsWith(join(root, '.chat-provider-check-')))
    rmSync(temporary, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
    report.cleaned = true
  } catch {
    report.cleaned = false
  }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
