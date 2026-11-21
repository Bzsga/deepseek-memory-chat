import assert from 'node:assert/strict'

export const destination = 'https://gateway.example.test/tenant/api'
export const customModel = 'synthetic-compatible-chat'
const root = 'https://root.example.test'
const official = 'https://api.deepseek.com'
const officialKey = 'synthetic-official-fixture-key'
const rootKey = 'synthetic-root-fixture-key'
const answers = new Map([[root, '根地址模型合成回复'], [destination, '子路径模型合成回复'], [official, '官方默认模型合成回复']])

export async function openAdvancedChat(page) {
  await page.getByRole('button', { name: '配置聊天 API', exact: true }).click()
  await page.getByRole('button', { name: '高级 API 设置', exact: true }).click()
  return page.getByRole('dialog', { name: '高级 API 设置', exact: true })
}

export function customEndpointFixture(subpathKey) {
  const seen = []
  const endpoints = [[root, root + '/v1', rootKey], [destination, destination, subpathKey], [official, official + '/v1', officialKey]]
  const serve = async route => {
    const req = route.request()
    const url = req.url()
    const target = endpoints.find(([base]) => new URL(url).origin === new URL(base).origin)
    if (!target) return false
    const [base, api, key] = target
    assert.equal(req.headers().authorization, `Bearer ${key}`)
    assert.equal(req.headers()['x-chat-user-id'], undefined)
    assert.equal(req.headers().cookie, undefined)
    seen.push(url)
    if (url === api + '/models') {
      assert.equal(req.method(), 'GET')
      await route.fulfill({json:{data:[{id:customModel}]}})
    } else {
      const isOfficial = base === official
      assert.equal(url, isOfficial ? official + '/anthropic/v1/messages' : api + '/chat/completions')
      const body = req.postDataJSON()
      assert.equal(req.method(), 'POST')
      assert.equal(body.stream, true)
      if (!isOfficial) assert.equal(body.model, customModel)
      const text = answers.get(base)
      const chunks = isOfficial ? [
        {type:'message_start',message:{id:'qa',model:body.model}},
        {type:'content_block_start',index:0,content_block:{type:'text',text}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn'}},
        {type:'message_stop'},
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') :
        'data: ' + JSON.stringify({id:'synthetic',choices:[{index:0,delta:{content:text},finish_reason:'stop'}]}) + '\n\ndata: [DONE]\n\n'
      await route.fulfill({contentType:'text/event-stream', body:chunks})
    }
    return true
  }
  async function exercise(page, origin) {
    const button = name => page.getByRole('button', {name,exact:true})
    await page.goto(origin + '/deepseek/')
    const draft = page.getByPlaceholder('请输入消息')
    const pendingText = '配置前保留这段草稿。'
    const provider = page.getByRole('dialog', {name:'聊天 API',exact:true})
    await draft.fill(pendingText)
    await button('发送').click()
    await provider.waitFor()
    assert.equal(await page.getByRole('dialog').count(), 1)
    assert.equal(new URL(page.url()).hash, '')
    await page.evaluate(() => history.back())
    await provider.waitFor({state:'hidden'})
    assert.equal(await draft.inputValue(), pendingText)
    await page.getByRole('button', {name:/^填写(?:个人)?\s*API Key/}).click()
    await provider.waitFor()
    await page.keyboard.press('Escape')
    await provider.waitFor({state:'hidden'})
    assert.equal(await draft.inputValue(), pendingText)
    for (const [base, key] of [[root,rootKey],[destination,subpathKey],[official,officialKey]]) {
      await button('设置').click()
      const form = await openAdvancedChat(page)
      await form.getByLabel('Base URL').fill(base === official ? '' : base)
      if (base !== root) {
        const before = seen.length
        await form.getByRole('button',{name:'获取模型列表'}).click()
        await page.getByText('请填写此服务的 API Key。',{exact:true}).waitFor()
        await form.getByRole('button', { name: '保存服务设置', exact: true }).click()
        await page.getByText('更改 Base URL 后请重新填写该服务的 API Key。',{exact:true}).waitFor()
        assert.equal(seen.length, before)
      }
      await form.getByPlaceholder(/输入个人 DeepSeek API Key|留空保留已保存的 Key/).fill(key)
      if (base !== official) {
        await form.getByRole('button',{name:'获取模型列表'}).click()
        await form.locator('select').selectOption(customModel)
      } else {await form.locator('input[list]').fill('')}
      await form.getByRole('button', { name: '保存服务设置', exact: true }).click()
      await form.waitFor({ state: 'hidden' })
      await page.keyboard.press('Escape')
      const composer = page.locator('textarea:visible').first()
      await composer.fill('请回答一次合成验证。')
      await button('发送').click()
      await page.getByText(answers.get(base),{exact:true}).first().waitFor()
      await button('发送').waitFor()
    }
    assert.ok(seen.includes(root + '/v1/models') && seen.includes(destination + '/models'))
  }
  return {serve, exercise}
}
