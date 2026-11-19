import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const compiler = process.argv[2] ?? path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const output = mkdtempSync(path.join(tmpdir(), 'deepseek-images-'))

try {
  const result = spawnSync(process.execPath, [
    compiler, path.join(root, 'src/services/chat/imageGeneration.ts'),
    '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler',
    '--strict', '--skipLibCheck', '--outDir', output,
  ], { encoding: 'utf8', cwd: output })
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Compiler did not finish')
  const emitted = path.join(output, 'imageGeneration.mjs')
  renameSync(path.join(output, 'imageGeneration.js'), emitted)
  const { decodeGeneratedImages, MAX_GENERATED_IMAGE_BYTES,
    cacheGeneratedImage, getCachedGeneratedImage, releaseGeneratedImage } =
    await import(pathToFileURL(emitted).href)

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
  const response = (bytes, mime_type = 'image/png') => ({
    model: 'synthetic-image-model', images: [{ b64_json: bytes.toString('base64'), mime_type }],
  })
  const image = decodeGeneratedImages(response(png)).images[0]
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.extension, 'png')
  assert.equal(image.blob.type, 'image/png')
  assert.deepEqual(Buffer.from(await image.blob.arrayBuffer()), png)
  const wrapped = response(png)
  wrapped.images[0].b64_json = `\n ${wrapped.images[0].b64_json}\r\n`
  assert.equal(decodeGeneratedImages(wrapped).images[0].blob.size, png.length)

  for (const invalid of [null, [], { model: 'test', images: [] },
    { model: 'test', images: [response(png).images[0], response(png).images[0]] },
    { model: 'test', images: [{ url: 'https://example.com/image.png', mime_type: 'image/png' }] },
    response(png, 'image/jpeg'), response(Buffer.from('<svg>unsafe</svg>'), 'image/svg+xml'),
    { model: 'test', images: [{ b64_json: 'a', mime_type: 'image/png' }] },
    { model: '', images: response(png).images }]) {
    assert.throws(() => decodeGeneratedImages(invalid))
  }
  assert.equal(decodeGeneratedImages(response(Buffer.from([255, 216, 255, 217]), 'image/jpeg')).images[0].extension, 'jpg')
  const webp = Buffer.from('RIFF\u0008\u0000\u0000\u0000WEBPVP8 ', 'latin1')
  assert.equal(decodeGeneratedImages(response(webp, 'image/webp')).images[0].extension, 'webp')

  const boundary = Buffer.alloc(MAX_GENERATED_IMAGE_BYTES)
  png.copy(boundary)
  assert.equal(decodeGeneratedImages(response(boundary)).images[0].blob.size, MAX_GENERATED_IMAGE_BYTES)
  assert.throws(() => decodeGeneratedImages(response(Buffer.alloc(MAX_GENERATED_IMAGE_BYTES + 1))))
  cacheGeneratedImage('unpersisted-image', image.blob)
  assert.equal(getCachedGeneratedImage('unpersisted-image'), image.blob)
  releaseGeneratedImage('unpersisted-image')
  assert.equal(getCachedGeneratedImage('unpersisted-image'), undefined)
  console.log('Image response checks passed: byte preservation, formats, MIME mismatch, URL rejection, size bounds, and result cache.')
} finally {
  const temporaryRoot = path.resolve(tmpdir()) + path.sep
  if (!path.resolve(output).startsWith(temporaryRoot) || !path.basename(output).startsWith('deepseek-images-')) {
    throw new Error('Refusing to remove an unexpected temporary path')
  }
  rmSync(output, { recursive: true, force: true })
}
