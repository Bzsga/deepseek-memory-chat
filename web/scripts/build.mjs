import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { renderChangelog } from './render-changelog.mjs'

const changelog = renderChangelog(await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'))
const result = spawnSync(process.execPath, ['node_modules/@rspack/cli/bin/rspack.js', 'build', '-c', 'rspack.config.ts'], {
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
await writeFile(new URL('../dist/changelog.html', import.meta.url), changelog)
