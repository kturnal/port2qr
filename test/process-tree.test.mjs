import assert from 'node:assert/strict'
import process from 'node:process'
import test from 'node:test'
import {processIsRunning} from '../src/process-liveness.mjs'
import {
  findOrphanedChildren,
  spawnProcessTree,
  stopProcessTree,
} from '../src/process-tree.mjs'

const lifetime = {startedAt: 1_000_000, exitedAt: 1_060_000}

test('selects children created while their exited parent was running', () => {
  const output = [
    '101 1000500',
    '102 1059900',
    '103 990000',
    '104 1070000',
    '',
  ].join('\r\n')

  assert.deepEqual(findOrphanedChildren(output, lifetime), [101, 102])
})

test('tolerates coarse clocks at the edges of the parent lifetime', () => {
  const output = ['201 999500', '202 1060500', '203 998999', '204 1061001'].join('\n')

  assert.deepEqual(findOrphanedChildren(output, lifetime), [201, 202])
})

test('ignores output that is not a child process record', () => {
  const output = [
    'WARNING: unexpected text',
    '301',
    '302 not-a-time',
    ' 303 1000500 ',
  ].join('\n')

  assert.deepEqual(findOrphanedChildren(output, lifetime), [303])
})

// On Windows, Node ends the children it did not detach when it exits, so the descendant is
// detached there to outlive its parent like the Node process that npm.cmd starts.
const parentScript = `
const {spawn} = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: process.platform === 'win32',
  stdio: 'ignore',
})
process.stdout.write(child.pid + '\\n', () => {
  if (process.env.PORT2QR_TEST_PARENT_EXITS === '1') process.exit(0)
})
setInterval(() => {}, 1000)
`

async function readLine(stream) {
  stream.setEncoding('utf8')
  let output = ''
  for await (const chunk of stream) {
    output += chunk
    const newline = output.indexOf('\n')
    if (newline !== -1) return output.slice(0, newline)
  }
  throw new Error(`Output ended before a complete line: ${output}`)
}

async function waitUntil(check, description) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function killIfRunning(pid) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function startTree(t, env = {}) {
  const parent = spawnProcessTree(process.execPath, ['-e', parentScript], {
    env: {...process.env, ...env},
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = new Promise(resolve => parent.once('exit', resolve))
  const descendant = Number(await readLine(parent.stdout))
  t.after(() => {
    killIfRunning(descendant)
    if (parent.exitCode === null) parent.kill('SIGKILL')
  })
  return {descendant, exited, parent}
}

test('stops a running process and its descendants', {timeout: 15_000}, async t => {
  const {descendant, exited, parent} = await startTree(t)
  assert.equal(processIsRunning(descendant), true)

  await stopProcessTree(parent)

  await exited
  await waitUntil(() => !processIsRunning(descendant), `descendant ${descendant} to stop`)
})

test('stops descendants that outlive their exited parent', {timeout: 15_000}, async t => {
  const {descendant, exited, parent} = await startTree(t, {PORT2QR_TEST_PARENT_EXITS: '1'})
  await exited
  assert.equal(processIsRunning(descendant), true)

  await stopProcessTree(parent)

  await waitUntil(() => !processIsRunning(descendant), `descendant ${descendant} to stop`)
})

test('ignores a process that could not start', {timeout: 15_000}, async () => {
  const child = spawnProcessTree('port2qr-missing-test-command', [], {stdio: 'ignore'})
  const error = await new Promise(resolve => child.once('error', resolve))
  assert.equal(error.code, 'ENOENT')

  await stopProcessTree(child)
})
