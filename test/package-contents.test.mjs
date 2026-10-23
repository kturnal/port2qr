import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

const packageRoot = new URL('..', import.meta.url)

function packedFilePaths() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    shell: true,
  })
  const [manifest] = JSON.parse(stdout)
  return manifest.files.map((file) => file.path)
}

test('publishes the runtime files plus the security policy', () => {
  assert.deepEqual(packedFilePaths().sort(), [
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'bin/port2qr.mjs',
    'package.json',
    'src/options.mjs',
    'src/process-liveness.mjs',
    'src/tunnel-url.mjs',
  ])
})

test('resolves the security policy link in the packaged README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const link = readme.match(/\[SECURITY\.md\]\(([^)]+)\)/)?.[1]
  assert.ok(link, 'the README should link to the security policy')
  assert.ok(packedFilePaths().includes(link), `the package should ship ${link}`)
})
