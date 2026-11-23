import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = 'https://digimonlegend.com'
const dist = fileURLToPath(new URL('../dist/', import.meta.url)).replace(/[\\/]$/, '')
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.woff2':'font/woff2' }
const browser = await chromium.launch({channel: 'msedge',
  args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']})
try {
  const context = await browser.newContext({ ...devices['Pixel 7'], locale:'zh-CN', serviceWorkers:'block' })
  let modelRequests = 0
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin && url.pathname.startsWith('/deepseek/')) {
      const path = resolve(dist, url.pathname.slice('/deepseek/'.length) || 'index.html')
      if (path.startsWith(dist + sep) && (await stat(path).catch(() => null))?.isFile()) {
        return route.fulfill({ body:await readFile(path), contentType:mime[extname(path)] || 'application/octet-stream' })
      }
    }
    if (url.href === origin + '/deepseek-api/chat/api/runtime') {
      return route.fulfill({status:401,json:{}})
    }
    if (/\/messages(?:\?|$)|\/chat-jobs\//.test(url.href)) modelRequests++
    return route.abort()
  })
  await context.addInitScript(() => {
    const add = window.addEventListener.bind(window)
    let receiver, port
    const calls = []
    const send = (frame) => port.onmessage({data:JSON.stringify({version:1,...frame})})
    window.addEventListener = (type, listener, options) => {
      if (type === 'message') receiver = listener
      return add(type,listener,options)
    }
    window.archiveTest = {
      calls,
      connect(trusted, memoryRefresh) {
        port = { start() {}, close() {}, postMessage(raw) {
          const message = JSON.parse(raw)
          calls.push(message)
          if (message.type === 'memory.open') {
            void send({id:message.id,type:'ack',ok:true})
          }
        } }
        receiver({ isTrusted:trusted,source:null,origin:'',ports:[port],
          data:JSON.stringify({version:1,type:'deepseek.connect',memoryRefresh}) })
      },
      create(payload) { return send({type:'continuation.create',id:'archive-fixture-continuation',payload}) },
      reply(payload) {
        const request = calls.filter(({type})=>type==='memory.refresh').at(-1)
        return send({type:'ack',id:request.id,ok:true,payload})
      },
      requestCount(type) {return calls.filter(call=>call.type===type).length},
    }
  })

  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  await page.goto(origin+'/deepseek/')
  await page.getByPlaceholder('请输入消息').waitFor()
  await page.evaluate(async () => {
    window.archiveTest.connect(true,false)
    await window.archiveTest.create({title:'合成档案',text:'档案旧背景。',sourceArchiveId:'archive-original'})
  })
  await page.getByRole('button',{name:'对话选项',exact:true}).click()
  await page.getByText('本次对话记忆',{exact:true}).click()
  const panel=page.getByRole('dialog',{ name:'本次对话记忆' })
  await panel.locator('summary').filter({hasText:'带入的背景记忆'}).click()
  const update=panel.getByRole('button',{ name:'更新背景', exact:true })
  await panel.getByText('档案旧背景。',{exact:true}).waitFor()
  assert.equal(await update.count(),0)
  await page.evaluate(()=>window.archiveTest.connect(false,true))
  assert.equal(await update.count(),0)
  await page.evaluate(()=>window.archiveTest.connect(true,true))

  await update.click()
  await panel.getByRole('button',{name:'取消',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.archiveTest.requestCount('memory.refresh')),0)
  await update.click()
  const confirm = panel.getByRole('button',{name:'确认更新',exact:true})
  await confirm.click()
  await page.waitForFunction(()=>window.archiveTest.requestCount('memory.refresh')===1)
  await page.evaluate(()=>window.archiveTest.reply({title:'错误来源',text:'不可使用的内容。',sourceArchiveId:'archive-other'}))
  await panel.getByText('档案旧背景。',{exact:true}).waitFor()
  await confirm.waitFor()
  assert.equal(await panel.getByText('不可使用的内容。',{exact:true}).count(),0)

  await confirm.click()
  await page.waitForFunction(()=>window.archiveTest.requestCount('memory.refresh')===2)
  await page.evaluate(()=>window.archiveTest.reply({title:'合成档案新标题',text:'档案已更新的背景。',sourceArchiveId:'archive-original'}))
  await panel.getByText('档案已更新的背景。',{exact:true}).waitFor()
  await panel.getByRole('button',{name:'打开来源档案',exact:true}).click()
  await panel.waitFor({state:'hidden'})
  const requests=await page.evaluate(()=>window.archiveTest.calls.filter(({type})=>type.startsWith('memory.')))
  assert.deepEqual(requests.map(({type,payload})=>[type,payload.archiveId]),
    [['memory.refresh','archive-original'],['memory.refresh','archive-original'],['memory.open','archive-original']])
  assert.equal(modelRequests,0)
  console.log('Trusted archive browser checks passed: legacy/forged rejection, confirmation, source-mismatch rejection, original archive open and local refresh. No model requests.')
} finally {
  await browser.close()
}
