import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(root, '.mcp-tool-arguments-check-'))
try {
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--noCheck', '--outDir', output],
  { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  const { checkMcpArguments, formMcpArguments, inputMcpArguments, mcpArgumentFields, parseMcpArguments } = await import(
    pathToFileURL(join(output, 'src/components/chatInput/mcpToolArguments.js')))

  const schema = {
    type: 'object', required: ['message', 'count'], additionalProperties: false,
    properties: {
      message: { type: 'string', title: 'Message' },
      count: { type: 'integer' },
      price: { type: 'number' },
      quiet: { type: 'boolean' },
      priority: { enum: [false, 'normal', 3, null] },
      key: { type: 'string', format: 'password' },
    },
  }
  const fields = mcpArgumentFields(schema)
  assert.deepEqual(fields.map(({ type }) => type), ['string', 'integer', 'number', 'boolean', 'enum', 'string'])
  assert.equal(fields[0].title, 'Message')
  assert.ok(fields[0].required && fields.at(-1).sensitive)
  assert.deepEqual(checkMcpArguments(schema, formMcpArguments(fields, {})), { issue: { kind: 'required', field: 'message' } })
  const args = { message: '', count: 0, price: 12.5, quiet: false, priority: null }
  const inputs = inputMcpArguments(fields, args)
  assert.deepEqual(formMcpArguments(fields, inputs), args)
  assert.deepEqual(checkMcpArguments(schema, parseMcpArguments(JSON.stringify(args)).args), { args })
  assert.deepEqual(checkMcpArguments(schema, { ...args, count: 1.5 }).issue, { kind: 'type', field: 'count' })
  assert.deepEqual(checkMcpArguments(schema, { ...args, count: Number.MAX_SAFE_INTEGER + 1 }).issue, { kind: 'number' })
  assert.deepEqual(checkMcpArguments(schema, { ...args, priority: true }).issue, { kind: 'enum', field: 'priority' })
  assert.deepEqual(checkMcpArguments(schema, { ...args, extra: 'value' }).issue, { kind: 'extra', field: 'extra' })
  assert.equal(inputMcpArguments(fields, { ...args, extra: 'value' }), undefined)

  const emptySchema = { type: 'object', properties: {} }
  assert.deepEqual(formMcpArguments(mcpArgumentFields(emptySchema), {}), {})
  assert.deepEqual(checkMcpArguments(emptySchema, {}), { args: {} })
  const noArguments = { type: 'object', additionalProperties: false }
  assert.deepEqual(mcpArgumentFields(noArguments), [])
  assert.deepEqual(checkMcpArguments(noArguments, {}), { args: {} })
  assert.equal(mcpArgumentFields({ type: 'object', minProperties: 1 }), undefined)
  const complex = { type: 'object', properties: { records: { type: 'array', items: { type: 'object' } } } }
  assert.equal(mcpArgumentFields(complex), undefined)
  assert.deepEqual(checkMcpArguments(complex, parseMcpArguments('{"records":[{"title":"Demo"}]}').args),
    { args: { records: [{ title: 'Demo' }] } })
  assert.deepEqual(parseMcpArguments('[]'), { issue: { kind: 'object' } })
  assert.deepEqual(parseMcpArguments('{'), { issue: { kind: 'json' } })
  assert.deepEqual(parseMcpArguments('{"records":[1e999]}'), { issue: { kind: 'number' } })
  assert.deepEqual(parseMcpArguments('{"records":[{"id":9007199254740993}]}'), { issue: { kind: 'number' } })
  assert.deepEqual(parseMcpArguments('{"records":[{"id":"9007199254740993"}]}').args,
    { records: [{ id: '9007199254740993' }] })
  const unusual = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}')
  assert.deepEqual(checkMcpArguments(unusual, {}), { issue: { kind: 'required', field: '__proto__' } })
  assert.ok(Object.hasOwn(formMcpArguments(mcpArgumentFields(unusual), JSON.parse('{"__proto__":"x"}')), '__proto__'))
  console.log('MCP argument checks passed: simple fields, explicit empty values, typed JSON, nested and empty arguments.')
} finally {
  rmSync(output, { recursive: true, force: true })
}
