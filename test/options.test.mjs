import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from '../src/options.mjs'

test('accepts a positional port and derives a safe loopback origin', () => {
  const options = parseArgs(['5173'])
  assert.equal(options.action, 'run')
  assert.equal(options.origin.href, 'http://127.0.0.1:5173/')
  assert.equal(options.hostHeader, '127.0.0.1:5173')
  assert.deepEqual(options.command, [])
})

test('keeps command arguments after the separator without invoking a shell', () => {
  const options = parseArgs(['3000', '--', 'npm', 'run', 'dev', '--', '--host'])
  assert.deepEqual(options.command, ['npm', 'run', 'dev', '--', '--host'])
})

test('supports a custom HTTPS origin and timeout', () => {
  const options = parseArgs(['--url', 'https://localhost:8443', '--timeout', '15'])
  assert.equal(options.origin.href, 'https://localhost:8443/')
  assert.equal(options.hostHeader, 'localhost:8443')
  assert.equal(options.timeoutMs, 15_000)
})

test('can preserve the public Host header explicitly', () => {
  const options = parseArgs(['8080', '--no-host-header'])
  assert.equal(options.hostHeader, null)
})

test('rejects credential-bearing origin URLs', () => {
  assert.throws(
    () => parseArgs(['--url', 'http://user:redacted@localhost:8080']),
    /must not contain a username or password/
  )
})

test('rejects non-loopback and token-bearing origin URLs', () => {
  assert.throws(() => parseArgs(['--url', 'http://192.168.1.20:8080']), /must use localhost/)
  assert.throws(() => parseArgs(['--url', 'http://localhost:8080/admin']), /must not contain a path/)
  assert.throws(() => parseArgs(['--url', 'http://localhost:8080/?token=redacted']), /must not contain a path/)
  assert.throws(() => parseArgs(['8080', '--host-header', 'localhost\nX-Test: value']), /control characters/)
})

test('rejects invalid and ambiguous inputs', () => {
  assert.throws(() => parseArgs([]), /Provide a local port/)
  assert.throws(() => parseArgs(['0']), /between 1 and 65535/)
  assert.throws(() => parseArgs(['70000']), /between 1 and 65535/)
  assert.throws(() => parseArgs(['3000', '--port', '4000']), /either positionally/)
  assert.throws(() => parseArgs(['3000', '--url', 'http://localhost:3000']), /either a port or --url/)
  assert.throws(() => parseArgs(['3000', '--']), /Expected a command/)
})

test('returns help and version actions without requiring an origin', () => {
  assert.deepEqual(parseArgs(['--help']), {action: 'help'})
  assert.deepEqual(parseArgs(['--version']), {action: 'version'})
})
