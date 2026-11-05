import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolveCommand} from '../src/command.mjs'

const packageRoot = new URL('..', import.meta.url)

function packedFilePaths() {
  // resolveCommand runs npm without a shell on Windows too.
  const {file, args} = resolveCommand(['npm', 'pack', '--dry-run', '--json'])
  const stdout = execFileSync(file, args, {cwd: packageRoot, encoding: 'utf8'})
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
    'src/command.mjs',
    'src/options.mjs',
    'src/process-liveness.mjs',
    'src/process-tree.mjs',
    'src/tunnel-url.mjs',
  ])
})

test('resolves the security policy link in the packaged README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const link = readme.match(/\[SECURITY\.md\]\(([^)]+)\)/)?.[1]
  assert.ok(link, 'the README should link to the security policy')
  assert.ok(packedFilePaths().includes(link), `the package should ship ${link}`)
})
