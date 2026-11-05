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

  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node)
})

test('keeps the README and CI matrix aligned with the engine floor', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'))
  const readme = readProjectFile('README.md')
  const workflow = readProjectFile('.github/workflows/test.yml')
  const minimumVersion = packageJson.engines.node.match(/^>=(\d+)$/)?.[1]
  const matrix = workflow.match(/node-version:\s*\[([^\]]+)\]/)?.[1]
    .split(',')
    .map(version => version.trim())

  assert.ok(minimumVersion, 'engines.node must use a >=<major> range')
  assert.match(readme, new RegExp(`Node\\.js ${minimumVersion} or newer`))
  assert.equal(matrix?.[0], minimumVersion)
})

test('keeps the CI job names and lifecycle operating systems stable', () => {
  const workflow = readProjectFile('.github/workflows/test.yml')

  // Branch protection selects required checks by these names.
  assert.match(workflow, /name: Unit tests \(Node\.js \$\{\{ matrix\.node-version \}\}\)/)
  assert.match(
    workflow,
    /name: Lifecycle tests \(\$\{\{ matrix\.os-name \}\}, Node\.js \$\{\{ matrix\.node-version \}\}\)/
  )
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    assert.match(workflow, new RegExp(`- os: ${os}\\n`))
  }
})
