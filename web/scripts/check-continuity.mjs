import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// An explicit compiler path also permits reusing an existing local toolchain.
const compiler = process.argv[2] ?? path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const output = mkdtempSync(path.join(tmpdir(), 'deepseek-continuity-'))

try {
  const result = spawnSync(process.execPath, [
    compiler,
    path.join(root, 'src/services/chat/continuity.ts'),
    '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler',
    '--strict', '--skipLibCheck', '--outDir', output,
  ], { encoding: 'utf8', cwd: output })
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Compiler did not finish')
  const emitted = path.join(output, 'continuity.mjs')
  renameSync(path.join(output, 'continuity.js'), emitted)
  const { validateContinuationPayload, buildContinuitySystem, MAX_CONTINUITY_BYTES } =
    await import(pathToFileURL(emitted).href)

  const original = {
    title: '海边的约定',
    sourceArchiveId: 'archive-123',
    text: '  我还没决定。\n你说：“可以慢慢来。”\n\n',
  }
  assert.deepEqual(validateContinuationPayload(original), original)
  assert.equal(buildContinuitySystem('助手身份'), '助手身份')
  const prompt = buildContinuitySystem('助手身份', original)
  assert.ok(prompt.startsWith('助手身份\n\n'))
  assert.deepEqual(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)), original)

  for (const invalid of [null, [], {}, { ...original, text: ' \n' },
    { ...original, title: '🙂'.repeat(257) }, { ...original, sourceArchiveId: '' },
    { ...original, text: '汉'.repeat(Math.floor(MAX_CONTINUITY_BYTES / 3) + 1) }]) {
    assert.throws(() => validateContinuationPayload(invalid))
  }
  const boundary = { ...original, title: '🙂'.repeat(256), text: '汉'.repeat(MAX_CONTINUITY_BYTES / 3) }
  assert.deepEqual(validateContinuationPayload(boundary), boundary)
  assert.equal(original.text, '  我还没决定。\n你说：“可以慢慢来。”\n\n')
  console.log('Continuity background checks passed: original wording, Unicode bounds, invalid data, and single background attachment.')
} finally {
  const temporaryRoot = path.resolve(tmpdir()) + path.sep
  if (!path.resolve(output).startsWith(temporaryRoot) || !path.basename(output).startsWith('deepseek-continuity-')) {
    throw new Error('Refusing to remove an unexpected temporary path')
  }
  rmSync(output, { recursive: true, force: true })
}
