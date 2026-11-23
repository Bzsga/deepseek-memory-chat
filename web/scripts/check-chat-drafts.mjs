import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
const web = resolve(dirname(script), '..')
const [scenario, directory] = process.argv.slice(2)
const guestText = '访客合成草稿\n未发送'
const accountText = '账号已有合成草稿'

if (!scenario) {
  const out = mkdtempSync(join(web, '.chat-drafts-'))
  try {
    execFileSync(process.execPath, [join(web, 'node_modules/typescript/bin/tsc'), '--project', join(web, 'tsconfig.json'),
      '--noEmit', 'false', '--outDir', out], { cwd: web })
    writeFileSync(join(out, 'device-storage.json'), '[]')
    for (const name of ['guest-write', 'account-write', 'other-account', 'account-reload', 'guest-reload']) {
      execFileSync(process.execPath, [script, name, out], { stdio: 'inherit' })
    }
    console.log('Local draft and reading-position reload, account isolation, send cleanup and history replacement passed')
  } finally {
    const target = realpathSync(out)
    assert.equal(dirname(target), realpathSync(web))
    assert.ok(basename(target).startsWith('.chat-drafts-'))
    rmSync(target, { force: true, recursive: true })
  }
} else {
  const storageFile = join(directory, 'device-storage.json')
  const data = new Map(JSON.parse(readFileSync(storageFile, 'utf8')))
  const persist = () => writeFileSync(storageFile, JSON.stringify([...data]))
  globalThis.localStorage = {
    get length() { return data.size },
    key(index) { return [...data.keys()][index] ?? null },
    getItem(key) { return data.get(key) ?? null },
    setItem(key, value) { data.set(key, value); persist() },
    removeItem(key) { data.delete(key); persist() },
  }
  globalThis.window = new EventTarget()
  globalThis.location = new URL('https://draft-check.invalid/deepseek/')
  globalThis.__API_ORIGIN__ = '/isolated/chat'
  globalThis.fetch = async () => { throw new Error('Network disabled for drafts test') }

  const load = (file) => import(pathToFileURL(join(directory, 'src/services', `${file}.js`)))
  const runtime = await load('runtime')
  const guest = scenario.startsWith('guest-')
  runtime.initializeRuntime(guest ? runtime.localGuestRuntime() : {
    model: 'synthetic', features: {},
    user: { id: scenario === 'other-account' ? 'synthetic-b' : 'synthetic-a', username: 'test', role: 'user' },
  })
  const drafts = await load('chat/drafts')
  const storage = await load('chat/draftTextStorage')
  const reading = await load('chat/readingPosition')
  const branch = JSON.stringify(['identical-session-id', 'start'])
  const guestPosition = { messageId: 'guest-marker', offset: -9 }
  const accountPosition = { messageId: 'account-marker', offset: -14 }

  if (scenario === 'guest-write') {
    reading.saveReadingPosition(branch, guestPosition)
    drafts.setDraftText('guest-session', guestText)
    drafts.setDraftText(null, '独立的新聊天草稿')
    assert.equal(drafts.getDraft('guest-session').text, guestText)
    assert.equal(drafts.getDraft(null).text, '独立的新聊天草稿')
  } else if (scenario === 'account-write') {
    assert.equal(reading.readReadingPosition(branch), undefined)
    reading.saveReadingPosition(branch, accountPosition)
    assert.equal(drafts.getDraft('guest-session').text, '')
    assert.equal(drafts.getDraft(null).text, '')
    drafts.setDraftText(null, '本次发送的临时草稿')
    drafts.setDraftText('account-session', accountText)
    drafts.clearSentDraft(null)
    assert.equal(drafts.getDraft(null).text, '')
    runtime.invalidateSession('changed', false)
    drafts.releaseDraftMemory()
    assert.equal(reading.readReadingPosition(branch), undefined)
    reading.saveReadingPosition(branch, { messageId: 'discard-after-sign-out', offset: 0 })
    assert.equal(drafts.getDraft('account-session').text, '')
  } else if (scenario === 'other-account') {
    assert.equal(drafts.getDraft('account-session').text, '')
    assert.equal(reading.readReadingPosition(branch), undefined)
  } else if (scenario === 'account-reload') {
    assert.equal(drafts.getDraft(null).text, '')
    assert.equal(drafts.getDraft('account-session').text, accountText)
    assert.equal(drafts.getDraft('guest-session').text, '')
    assert.deepEqual(reading.readReadingPosition(branch), accountPosition)
    const beforeReplace = reading.readingPositionRevision()
    drafts.clearAllDrafts()
    reading.clearSavedReadingPositions()
    assert.equal(storage.loadDraftText().size, 0)
    assert.equal(reading.readReadingPosition(branch), undefined)
    assert.notEqual(reading.readingPositionRevision(), beforeReplace)
  } else if (scenario === 'guest-reload') {
    assert.equal(drafts.getDraft(null).text, '独立的新聊天草稿')
    assert.equal(drafts.getDraft('guest-session').text, guestText)
    assert.equal(drafts.getDraft('account-session').text, '')
    assert.deepEqual(reading.readReadingPosition(branch), guestPosition)
    drafts.clearDraft('guest-session')
    assert.equal(storage.loadDraftText().has('guest-session'), false)
    assert.equal(storage.loadDraftText().has(null), true)
  }
}
