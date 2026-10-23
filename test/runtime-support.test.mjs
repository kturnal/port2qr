import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'

const packageRoot = new URL('..', import.meta.url)

function readProjectFile(path) {
  return readFileSync(new URL(path, packageRoot), 'utf8')
}

test('keeps the package metadata on the supported Node.js baseline', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'))
  const packageLock = JSON.parse(readProjectFile('package-lock.json'))

  assert.equal(packageJson.engines.node, '>=22')
  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node)
})

test('documents and tests only the maintained Node.js LTS lines', () => {
  const readme = readProjectFile('README.md')
  const workflow = readProjectFile('.github/workflows/test.yml')
  const matrix = workflow.match(/node-version:\s*\[([^\]]+)\]/)?.[1]
    .split(',')
    .map(version => version.trim())

  assert.match(readme, /Node\.js 22 or newer/)
  assert.match(readme, /CI currently tests Node\.js 22 and 24/)
  assert.match(readme, /support for a release line ends when it reaches upstream end-of-life/)
  assert.deepEqual(matrix, ['22', '24'])
})
