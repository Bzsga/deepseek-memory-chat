import assert from 'node:assert/strict'
import { extname, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const dist = resolve(process.argv[2] || fileURLToPath(new URL('../dist', import.meta.url)))
const baseline = process.argv[3] ? resolve(process.argv[3]) : undefined
let assets = dist
const origin = 'https://history-import.example.test'
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
const date = '2026-11-22T00:00:00Z'
const manifest = { export_format_version: 3 }
const pathFor = (id) => 'chat_sessions/' + id + '_files/shared-photo_photo.png'
const image = (token) => Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, token)
const json = (value) => JSON.stringify(value)

const session = (id, title, token) => ({
  id, title, inserted_at: date, updated_at: date, pinned: false, current_message_id: 1,
  messages: [{
    id: 1, parent_id: null, role: 'USER', status: 'FINISHED', thinking_enabled: false,
    search_enabled: false, accumulated_token_usage: 0, inserted_at: date,
    fragments: [
      { type: 'REQUEST', content: '合成导入用对话。' },
      ...(token === undefined ? [] : [{ type: 'FILE', files: [{
        id: 'shared-photo', file_name: 'photo.png', file_size: image(token).length,
        token_usage: null, inserted_at: date, export_path: pathFor(id),
        is_image: true, width: null, height: null,
      }] }]),
    ],
  }],
})

function single() {
  return {
    name: 'single.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json({
      format: 'deepseek-session', version: 1, manifest,
      session: session('existing', '新设备已有版本', 21),
      files: [{ path: pathFor('existing'), mime_type: 'image/png', data_base64: Buffer.from(image(21)).toString('base64') }],
    })),
  }
}

function archive(rows, damaged = false) {
  const data = { 'manifest.json': strToU8(json(manifest)) }
  for (const [id, title, token] of rows) {
    data['chat_sessions/' + id + '.json'] = strToU8(json(session(id, title, token)))
  }
  // Index labels are advisory and preview must use the corresponding session record.
  data['chat_session_index.json'] = strToU8(json(rows.map(([id]) => ({
    id, title: '索引中的标签', message_count: 0, inserted_at: date, updated_at: date,
  }))))
  for (const [id, , token] of rows) {
    if (token !== undefined) {data[pathFor(id)] = image(token)}
  }
  if (damaged) {data['unexpected-path'] = strToU8('synthetic')}
  return { name: 'history.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(data)) }
}

const browser = await chromium.launch({
  ...(process.env.HISTORY_QA_CHROMIUM ? { executablePath: process.env.HISTORY_QA_CHROMIUM }
    : { channel: process.env.BROWSER_CHANNEL || 'msedge' }),
  args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'],
})
try {
  const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN', serviceWorkers: 'block' })
  const requests = []
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin && url.pathname === '/deepseek-api/chat/api/runtime') {
      return route.fulfill({ status: 401, json: {} })
    }
    if (url.origin === origin && url.pathname.startsWith('/deepseek/')) {
      const file = resolve(assets, url.pathname.slice('/deepseek/'.length) || 'index.html')
      assert.ok(file.startsWith(assets + sep))
      return route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] || 'application/octet-stream' })
    }
    if (url.origin === origin && url.pathname === '/favicon.ico') {return route.fulfill({ status: 204 })}
    requests.push(url.pathname)
    return route.abort()
  })
  const page = await context.newPage()
  await page.goto(origin + '/deepseek/#settings/data')
  const dataModal = page.getByRole('dialog', { name: '设置', exact: true })
  const choose = async (label, file) => {
    const result = page.waitForEvent('filechooser')
    await dataModal.getByRole('button', { name: label, exact: true }).click()
    await (await result).setFiles(file)
    const preview = page.getByRole('dialog', { name: label, exact: true })
    await preview.waitFor()
    return preview
  }
  const confirm = (modal, label) => modal.getByRole('button', { name: label, exact: true }).click()
  const snapshot = () => page.evaluate(async () => {
    const request = (r) => new Promise((resolveRequest, reject) => {
      r.onsuccess = () => resolveRequest(r.result)
      r.onerror = () => reject(r.error)
    })
    const database = (await indexedDB.databases()).find(({ name }) => name?.endsWith('chats'))
    if (!database || database.version !== 12) {throw new Error('Expected existing chat DB schema v12')}
    const db = await request(indexedDB.open(database.name))
    try {
      const chats = await request(db.transaction('sessions').objectStore('sessions').getAll())
      const rows = {}
      for (const chat of chats) {
        const file = chat.messages[0]?.files?.[0]
        const blob = file && (await request(db.transaction('files').objectStore('files').get(file.id)))?.blob
        rows[chat.id] = { title: chat.title, imageId: file?.id, token: blob && new Uint8Array(await blob.arrayBuffer()).at(-1) }
      }
      const originals = await request(db.transaction('files').objectStore('files').count())
      return { rows, originals, objectStores: [...db.objectStoreNames] }
    } finally {
      db.close()
    }
  })

  const append = '添加旧聊天'
  const restore = '恢复整库备份'
  let preview = await choose(append, single())
  await preview.getByRole('checkbox', { name: '新设备已有版本', exact: true }).waitFor()
  await confirm(preview, append)
  await page.getByRole('button', { name: '新设备已有版本', exact: true }).waitFor()
  await page.goto(origin + '/deepseek/?check=initial#settings/data')
  await dataModal.getByRole('button', { name: append, exact: true }).waitFor()
  const initial = await snapshot()
  assert.equal(initial.rows.existing.token, 21)
  assert.equal(initial.originals, 1)
  assert.ok(!initial.objectStores.includes('historyAppendStaging'))

  preview = await choose(append, archive([
    ['existing', '备份中的旧版本', 5], ['selected', '要追加的对话', 41], ['omitted', '这次不导入', 84],
  ]))
  const duplicate = preview.getByRole('checkbox', { name: /备份中的旧版本/ })
  assert.equal(await duplicate.isDisabled(), true)
  await preview.getByRole('checkbox', { name: '这次不导入', exact: true }).uncheck()
  await preview.getByText('文件含 3 个聊天，已选 1 个。').waitFor()
  await confirm(preview, append)
  await page.getByRole('button', { name: '要追加的对话', exact: true }).waitFor()
  await page.goto(origin + '/deepseek/?check=append#settings/data')
  await dataModal.getByRole('button', { name: append, exact: true }).waitFor()
  const appended = await snapshot()
  assert.deepEqual(appended.rows.existing, initial.rows.existing)
  assert.equal(appended.rows.selected.token, 41)
  assert.notEqual(appended.rows.selected.imageId, initial.rows.existing.imageId)
  assert.equal(appended.rows.omitted, undefined)
  assert.equal(appended.originals, 2)

  if (baseline) {
    assets = baseline
    await page.goto(origin + '/deepseek/?check=rollback')
    await page.getByRole('button', { name: '打开边栏', exact: true }).click()
    await page.getByRole('button', { name: '要追加的对话', exact: true }).waitFor()
    assert.deepEqual(await snapshot(), appended)
    assets = dist
    await page.goto(origin + '/deepseek/?check=malformed#settings/data')
  }

  const oversized = archive([['oversized', '超过选择上限的附件', 95]])
  const zip = oversized.buffer
  let central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  while (central >= 0 && zip.readUInt32LE(central) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(central + 28)
    const entryPath = zip.toString('utf8', central + 46, central + 46 + nameLength)
    if (entryPath === pathFor('oversized')) {
      const local = zip.readUInt32LE(central + 42)
      zip.writeUInt16LE(8, central + 10)
      zip.writeUInt16LE(8, local + 8)
      zip.writeUInt32LE(64 * 1024 * 1024 + 1, central + 24)
      zip.writeUInt32LE(64 * 1024 * 1024 + 1, local + 22)
      break
    }
    central += 46 + nameLength + zip.readUInt16LE(central + 30) + zip.readUInt16LE(central + 32)
  }
  assert.equal(zip.readUInt32LE(central + 24), 64 * 1024 * 1024 + 1)
  preview = await choose(append, oversized)
  await confirm(preview, append)
  await dataModal.getByRole('alert').filter({ hasText: '超过 64 MB' }).waitFor()
  assert.deepEqual(await snapshot(), appended)

  preview = await choose(append, archive([['corrupt', '不完整文件中的会话', 92]], true))
  await confirm(preview, append)
  await dataModal.getByRole('alert').filter({ hasText: '文件内容不完整' }).waitFor()
  assert.deepEqual(await snapshot(), appended)

  preview = await choose(restore, archive([['restore', '恢复的备份']]))
  await preview.getByText('将用备份中的 1 个聊天替换本机的 2 个聊天及本机聊天附件。').waitFor()
  assert.deepEqual(await snapshot(), appended)
  await confirm(preview, restore)
  await dataModal.locator('button[aria-label="恢复整库备份"]:not([disabled])').waitFor()
  const restored = await snapshot()
  assert.deepEqual(Object.keys(restored.rows), ['restore'])
  assert.equal(restored.originals, 0)

  preview = await choose(restore, single())
  await preview.getByText('将用备份中的 1 个聊天替换本机的 1 个聊天及本机聊天附件。').waitFor()
  await confirm(preview, restore)
  await dataModal.locator('button[aria-label="恢复整库备份"]:not([disabled])').waitFor()
  const restoredJson = await snapshot()
  assert.deepEqual(Object.keys(restoredJson.rows), ['existing'])
  assert.equal(restoredJson.rows.existing.token, 21)
  assert.equal(restoredJson.originals, 1)
  assert.ok(requests.every((path) => !path.startsWith('/deepseek-api/')), 'Unexpected application API request')
  console.log(JSON.stringify({ ok: true, schema: 12, appendJson: true, selectedZip: true,
    attachments: true, duplicates: true, oversizedRejected: true, rollbackCompatible: Boolean(baseline),
    corruptAtomic: true, restoreZip: true, restoreJson: true, browser: browser.version() }))
} finally {
  await browser.close()
}
