import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['node_modules/@rspack/cli/bin/rspack.js', 'build', '-c', 'rspack.config.ts'], {
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
