import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = 'https://digimonlegend.com'
const dist = fileURLToPath(new URL('../dist/', import.meta.url)).replace(/[\\/]$/, '')
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.woff2':'font/woff2' }
const browser = await chromium.launch({channel:'msedge',args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']})
try {
  const context = await browser.newContext({viewport:{width:1280,height:820},locale:'zh-CN',serviceWorkers:'block'})
  let modelCalls=0
  await context.route('**/*', async route => {
    const url=new URL(route.request().url())
    if (url.origin===origin && url.pathname.startsWith('/deepseek/')) {
      const disk=resolve(dist,url.pathname.slice('/deepseek/'.length)||'index.html')
      if(disk.startsWith(dist+sep)&&(await stat(disk).catch(()=>null))?.isFile()){
        return route.fulfill({body:await readFile(disk),contentType:mime[extname(disk)]||'application/octet-stream'})
      }
    }
    if(url.href===origin+'/deepseek-api/chat/api/runtime'){return route.fulfill({status:401,json:{}})}
    if(/\/messages(?:\?|$)|\/chat-jobs\//.test(url.href)){modelCalls++}
    return route.abort()
  })
  const page=await context.newPage()
  page.setDefaultTimeout(12000)
  await page.goto(origin+'/deepseek/')
  await page.getByPlaceholder('请输入消息').waitFor()
  await page.waitForFunction(async ()=>(await indexedDB.databases()).some(({name})=>name.endsWith(':chats')))
  await page.evaluate(async () => {
    const {name}= (await indexedDB.databases()).find(database=>database.name.endsWith(':chats'))
    const req=indexedDB.open(name)
    const db=await new Promise((ok,fail)=>{req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(req.error)})
    const timestamp=Date.now()
    const main={id:'search-old', title:'样本标题 [Archive]-A',createdAt:timestamp-1000,updatedAt:timestamp-1000,rootMessageId:'query-0',messages:[]}
    for(let i=0;i<48;i++){
      const user='query-'+i
      const assistant='reply-'+i
      main.messages.push({id:user,role:'user',createdAt:timestamp-1000+i*2,
        parentId:i===0?null:'reply-'+(i-1),selectedChildId:assistant,files:[],
        content:i===0?'第一段早期消息 old-page-key':'聊天段落 '+i+'。用来验证跳转页面。'})
      main.messages.push({id:assistant,role:'assistant',createdAt:timestamp-999+i*2,
        parentId:user,selectedChildId:i===47?undefined:'query-'+(i+1),status:'done',stopReason:'end_turn',
        blocks:[{type:'text',text:'普通回复 '+i}]})
    }
    main.messages.push({id:'branch-reply',role:'assistant',createdAt:timestamp-700,parentId:'query-0',status:'done',
      stopReason:'end_turn',blocks:[{type:'text',text:'其他分支信息 CROSS-BRANCH'},
        {type:'thinking',thinking:'PRIVATE-THOUGHT-HIDDEN'},{type:'text',text:'TEMPLATE-CONTROL-HIDDEN',isTemplate:true}]})
    main.messages.push({id:'refusal-hidden',role:'assistant',createdAt:timestamp-690,parentId:'query-0',status:'done',
      stopReason:'refusal',blocks:[{type:'text',text:'REFUSED-OUTPUT-HIDDEN'}]})
    const alternate={id:'search-other',title:'第二样本标题',createdAt:timestamp,updatedAt:timestamp,rootMessageId:'other-root',
      messages:[{id:'other-root',role:'user',parentId:null,createdAt:timestamp,files:[],content:'普通独立合成会话。'}]}
    const tx=db.transaction(['sessions','sessionSummaries'],'readwrite')
    for(const session of [main,alternate]){
      tx.objectStore('sessions').put(session)
      tx.objectStore('sessionSummaries').put({id:session.id,title:session.title,createdAt:session.createdAt,updatedAt:session.updatedAt,fileIds:[]})
    }
    await new Promise((ok,fail)=>{tx.oncomplete=ok;tx.onabort=()=>fail(tx.error)})
    db.close()
  })
  await page.reload()
  const globalSearch=page.getByRole('searchbox',{name:'搜索会话标题或正文'})
  await globalSearch.fill('CROSS-BRANCH')
  await globalSearch.fill('[archive]-a')
  await page.getByRole('button',{name:/样本标题 \[Archive\]-A/}).click()
  await page.getByRole('button',{name:'查找本对话消息',exact:true}).waitFor()
  const old=page.locator('[data-chat-message="query-0"]')
  assert.equal(await old.count(),0)
  await page.getByRole('button',{name:'查找本对话消息',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'查找本对话消息'})
  await dialog.getByRole('searchbox').fill('OLD-PAGE-KEY')
  await dialog.getByRole('button',{name:/第一段早期消息 old-page-key/}).click()
  await dialog.waitFor({state:'hidden'})
  await page.locator('[data-chat-message="query-0"][data-chat-located]').waitFor({state:'attached'})

  await globalSearch.fill('第二样本标题')
  await page.getByRole('button',{name:'第二样本标题',exact:true}).click()
  await page.getByText('普通独立合成会话。',{exact:true}).waitFor()
  await globalSearch.fill('cross-branch')
  await page.getByRole('button',{name:/其他分支信息 CROSS-BRANCH/}).click()
  await page.locator('[data-chat-message="branch-reply"][data-chat-located]').waitFor({state:'attached'})
  assert.equal(await page.locator('[data-chat-message="reply-0"]').count(),0)
  for (const keyword of ['PRIVATE-THOUGHT-HIDDEN','TEMPLATE-CONTROL-HIDDEN','REFUSED-OUTPUT-HIDDEN']) {
    await globalSearch.fill(keyword)
    await page.getByRole('status').filter({hasText:/没有匹配|未找到/}).waitFor()
    assert.equal(await page.locator('mark').filter({hasText:keyword}).count(),0)
  }
  assert.equal(modelCalls,0)
  console.log('Built Edge search passed: literal title, full local messages, older-page jump, hidden-branch navigation, internal text excluded, no model calls.')
}finally{
  await browser.close()
}
