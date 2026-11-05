import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {resolveCommand} from '../src/command.mjs'

const nodeDir = 'C:\\Program Files\\nodejs'
const userBin = 'C:\\Users\\dev\\AppData\\Roaming\\npm'

function windowsFiles(...files) {
  const existing = new Set(files.map(file => file.toLowerCase()))
  return file => existing.has(file.toLowerCase())
}

function resolveOnWindows(command, files, env = {Path: `C:\\Windows\\System32;"${nodeDir}"`}) {
  return resolveCommand(command, {
    env,
    execPath: 'C:\\runtime\\node.exe',
    existsSync: windowsFiles(...files),
    platform: 'win32',
  })
}

test('passes commands through unchanged outside Windows', () => {
  assert.deepEqual(
    resolveCommand(['npm', 'run', 'dev'], {platform: 'linux'}),
    {file: 'npm', args: ['run', 'dev']}
  )
})

test('passes other Windows commands through unchanged', () => {
  assert.deepEqual(
    resolveOnWindows(['node', 'server.js', '&', 'calc'], []),
    {file: 'node', args: ['server.js', '&', 'calc']}
  )
})

test('runs npm on Windows through npm-cli.js and the bundled node.exe', () => {
  const cli = path.win32.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const files = [
    path.win32.join(nodeDir, 'npm.cmd'),
    cli,
    path.win32.join(nodeDir, 'node.exe'),
  ]

  assert.deepEqual(resolveOnWindows(['npm', 'run', 'dev', '--', '--host'], files), {
    file: path.win32.join(nodeDir, 'node.exe'),
    args: [cli, 'run', 'dev', '--', '--host'],
  })
  assert.equal(resolveOnWindows(['NPM.cmd', 'start'], files).args[0], cli)
})

test('runs npx on Windows with the current node when no node.exe is beside the shim', () => {
  const cli = path.win32.join(userBin, 'node_modules', 'npm', 'bin', 'npx-cli.js')
  const result = resolveOnWindows(
    ['npx', 'vite'],
    [path.win32.join(userBin, 'npx.cmd'), cli],
    {PATH: `${userBin};${nodeDir}`}
  )

  assert.deepEqual(result, {file: 'C:\\runtime\\node.exe', args: [cli, 'vite']})
})

test('skips Windows shims without an npm installation beside them', () => {
  const cli = path.win32.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const result = resolveOnWindows(
    ['npm', 'test'],
    [path.win32.join(userBin, 'npm.cmd'), path.win32.join(nodeDir, 'npm.cmd'), cli],
    {PATH: `${userBin};${nodeDir}`}
  )

  assert.deepEqual(result.args, [cli, 'test'])
})

test('reports npm missing from the Windows PATH', () => {
  assert.throws(() => resolveOnWindows(['npm', 'start'], []), /npm was not found on PATH/)
})
