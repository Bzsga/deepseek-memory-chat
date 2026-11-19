import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Local preview only: every account runtime request is an unauthenticated response.
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('Run pnpm build first.')
const port = Number(process.env.GUEST_PREVIEW_PORT ?? 18091)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  if (pathname === '/deepseek-api/chat/api/runtime') {
    response.writeHead(401, { 'content-type': 'application/json' }).end('{}')
    return
  }
  if (pathname.startsWith('/deepseek-api/')) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('本地访客预览不提供登录或模型服务。')
    return
  }
  const name = pathname === '/deepseek/' ? 'index.html' : pathname.replace(/^\/deepseek\//, '')
  const file = resolve(dist, name)
  if (!file.startsWith(dist + sep) || !existsSync(file) || request.method !== 'GET') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
    .end(readFileSync(file))
}).listen(port, '127.0.0.1', () => {
  console.log(`Guest preview: http://127.0.0.1:${port}/deepseek/ (synthetic 401, no model service)`)
})
