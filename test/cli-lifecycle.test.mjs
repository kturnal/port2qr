import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import {createCliHarness, originFixturePath} from '../test-fixtures/cli-harness.mjs'

const TEST_TUNNEL_URL = 'https://deterministic-test.trycloudflare.com'
const lifecycleTest = process.platform === 'win32' ? test.skip : test

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function close(server) {
  if (!server.listening) return
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function createExistingOrigin(t) {
  const server = http.createServer((_request, response) => {
    response.writeHead(204)
    response.end()
  })
  const port = await listen(server)
  t.after(() => close(server))
  return {port, server}
}

async function getAvailablePort() {
  const server = net.createServer()
  const port = await listen(server)
  await close(server)
  return port
}

async function originResponds(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}`, response => {
      response.resume()
      resolve(true)
    })
    request.once('error', () => resolve(false))
  })
}

function assertExit(result, code) {
  assert.equal(result.code, code)
  assert.equal(result.signal, null)
}

lifecycleTest('uses an existing origin without treating it as an owned process', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const origin = await createExistingOrigin(t)
  const run = harness.start([String(origin.port), '--timeout', '2'])

  await run.waitForOutput(TEST_TUNNEL_URL)
  run.signal('SIGTERM')
  assertExit(await run.waitForExit(), 0)

  assert.match(run.stdout, /Scan the QR code on your phone/)
  assert.match(run.stdout, /Stopping port2qr/)
  assert.equal(run.stderr, '')
  await harness.assertProcessStopped('tunnel.pid')
  assert.equal(await originResponds(origin.port), true, 'the unowned origin should still be running')
  assert.equal(await harness.stateExists('origin.pid'), false)
})

lifecycleTest('starts an owned origin and passes command arguments without a shell', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const port = await getAvailablePort()
  const commandArgs = ['space value', '$HOME', '$(exit 91)', ';', 'exit', '92']
  const run = harness.start([
    String(port),
    '--timeout',
    '3',
    '--',
    process.execPath,
    originFixturePath,
    ...commandArgs,
  ], {
    PORT2QR_ORIGIN_PORT: String(port),
    PORT2QR_ORIGIN_SPAWN_CHILD: '1',
  })

  await run.waitForOutput(TEST_TUNNEL_URL)
  run.signal('SIGTERM')
  assertExit(await run.waitForExit(), 0)

  assert.deepEqual(await harness.readStateJson('origin-args.json'), commandArgs)
  assert.deepEqual(await harness.readStateJson('tunnel-args.json'), [
    'tunnel',
    '--url',
    `http://127.0.0.1:${port}/`,
    '--http-host-header',
    `127.0.0.1:${port}`,
    '--no-autoupdate',
  ])
  await Promise.all([
    harness.assertProcessStopped('origin.pid'),
    harness.assertPidStopped('origin-child.pid'),
    harness.assertProcessStopped('tunnel.pid'),
  ])
})

lifecycleTest('reports a missing cloudflared executable', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t, {fakeCloudflared: false})
  const run = harness.start(['43210'], {PATH: harness.binDir})

  const result = await run.waitForExit()

  assertExit(result, 1)
  assert.match(run.stderr, /cloudflared is not installed or is not on PATH/)
  assert.equal(await harness.stateExists('origin.pid'), false)
  assert.equal(await harness.stateExists('tunnel.pid'), false)
})

lifecycleTest('rejects a conflicting standard Cloudflare configuration file', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const configDir = path.join(harness.homeDir, '.cloudflared')
  await mkdir(configDir, {recursive: true})
  await writeFile(path.join(configDir, 'config.yml'), 'tunnel: intentionally-conflicting\n')
  const run = harness.start(['43210'])

  const result = await run.waitForExit()

  assertExit(result, 1)
  assert.match(run.stderr, /Quick Tunnels do not support ~\/\.cloudflared\/config\.yml/)
  assert.equal(await harness.stateExists('origin.pid'), false)
  assert.equal(await harness.stateExists('tunnel.pid'), false)
})

lifecycleTest('times out waiting for an owned origin and stops its process', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const port = await getAvailablePort()
  const run = harness.start([
    String(port),
    '--timeout',
    '1',
    '--',
    process.execPath,
    originFixturePath,
  ], {
    PORT2QR_ORIGIN_DELAY_MS: '5000',
    PORT2QR_ORIGIN_PORT: String(port),
  })

  const result = await run.waitForExit()

  assertExit(result, 1)
  assert.match(run.stderr, new RegExp(`origin did not become ready at http://127\\.0\\.0\\.1:${port}/ within 1 seconds`))
  await harness.assertProcessStopped('origin.pid')
  assert.equal(await harness.stateExists('tunnel.pid'), false)
})

lifecycleTest('times out waiting for a tunnel URL and stops the tunnel', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const origin = await createExistingOrigin(t)
  const run = harness.start([String(origin.port), '--timeout', '1'], {
    PORT2QR_FAKE_TUNNEL_MODE: 'delay',
  })

  const result = await run.waitForExit()

  assertExit(result, 1)
  assert.match(run.stderr, /Cloudflare did not provide a Quick Tunnel URL within 1 seconds/)
  await harness.assertProcessStopped('tunnel.pid')
  assert.equal(await originResponds(origin.port), true, 'the unowned origin should still be running')
})

lifecycleTest('reports a local command that exits before the origin is ready', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const port = await getAvailablePort()
  const run = harness.start([
    String(port),
    '--timeout',
    '2',
    '--',
    process.execPath,
    originFixturePath,
  ], {
    PORT2QR_ORIGIN_EXIT_CODE: '23',
    PORT2QR_ORIGIN_PORT: String(port),
    PORT2QR_ORIGIN_SPAWN_CHILD: '1',
  })

  const result = await run.waitForExit()

  assertExit(result, 1)
  assert.match(run.stderr, /Local command exited unexpectedly \(code 23\)/)
  await Promise.all([
    harness.assertProcessStopped('origin.pid'),
    harness.assertPidStopped('origin-child.pid'),
  ])
  assert.equal(await harness.stateExists('tunnel.pid'), false)
})

lifecycleTest('reports a tunnel that exits before publishing a URL', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const origin = await createExistingOrigin(t)
  const run = harness.start([String(origin.port), '--timeout', '2'], {
    PORT2QR_FAKE_TUNNEL_EXIT_CODE: '17',
    PORT2QR_FAKE_TUNNEL_MODE: 'fail',
  })

  const result = await run.waitForExit()

  assertExit(result, 1)
  assert.match(run.stderr, /Cloudflare Tunnel exited unexpectedly \(code 17\)/)
  assert.match(run.stderr, /simulated cloudflared failure/)
  await harness.assertProcessStopped('tunnel.pid')
})

lifecycleTest('reports a tunnel that exits after publishing a URL and stops its peer group', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const port = await getAvailablePort()
  const run = harness.start([
    String(port),
    '--timeout',
    '3',
    '--',
    process.execPath,
    originFixturePath,
  ], {
    PORT2QR_FAKE_TUNNEL_EXIT_CODE: '18',
    PORT2QR_FAKE_TUNNEL_MODE: 'exit',
    PORT2QR_ORIGIN_PORT: String(port),
    PORT2QR_ORIGIN_SPAWN_CHILD: '1',
  })

  const result = await run.waitForExit()

  assertExit(result, 1)
  assert.ok(run.stdout.includes(TEST_TUNNEL_URL))
  assert.match(run.stdout, /Scan the QR code on your phone/)
  assert.match(run.stderr, /Cloudflare Tunnel exited unexpectedly \(code 18\)/)
  await Promise.all([
    harness.assertProcessStopped('origin.pid'),
    harness.assertPidStopped('origin-child.pid'),
    harness.assertProcessStopped('tunnel.pid'),
  ])
})

lifecycleTest('handles SIGINT while the owned origin is starting', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const port = await getAvailablePort()
  const run = harness.start([
    String(port),
    '--timeout',
    '10',
    '--',
    process.execPath,
    originFixturePath,
  ], {
    PORT2QR_ORIGIN_DELAY_MS: '5000',
    PORT2QR_ORIGIN_PORT: String(port),
  })

  await harness.waitForState('origin.pid')
  run.signal('SIGINT')
  assertExit(await run.waitForExit(), 0)

  assert.match(run.stdout, /Stopping port2qr/)
  assert.doesNotMatch(run.stderr, /port2qr:/)
  await harness.assertProcessStopped('origin.pid')
  assert.equal(await harness.stateExists('tunnel.pid'), false)
})

lifecycleTest('handles SIGINT while waiting for the tunnel URL', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const port = await getAvailablePort()
  const run = harness.start([
    String(port),
    '--timeout',
    '10',
    '--',
    process.execPath,
    originFixturePath,
  ], {
    PORT2QR_FAKE_TUNNEL_MODE: 'delay',
    PORT2QR_ORIGIN_PORT: String(port),
    PORT2QR_ORIGIN_SPAWN_CHILD: '1',
  })

  await harness.waitForState('tunnel.pid')
  run.signal('SIGINT')
  assertExit(await run.waitForExit(), 0)

  assert.match(run.stdout, /Stopping port2qr/)
  assert.doesNotMatch(run.stderr, /port2qr:/)
  await Promise.all([
    harness.assertProcessStopped('origin.pid'),
    harness.assertPidStopped('origin-child.pid'),
    harness.assertProcessStopped('tunnel.pid'),
  ])
})

lifecycleTest('handles SIGINT after printing the QR URL and stops both owned processes', {timeout: 15_000}, async t => {
  const harness = await createCliHarness(t)
  const port = await getAvailablePort()
  const run = harness.start([
    String(port),
    '--timeout',
    '3',
    '--',
    process.execPath,
    originFixturePath,
  ], {PORT2QR_ORIGIN_PORT: String(port)})

  await run.waitForOutput(/Scan the QR code on your phone/)
  run.signal('SIGINT')
  assertExit(await run.waitForExit(), 0)

  assert.ok(run.stdout.includes(TEST_TUNNEL_URL))
  assert.match(run.stdout, /Stopping port2qr/)
  await Promise.all([
    harness.assertProcessStopped('origin.pid'),
    harness.assertProcessStopped('tunnel.pid'),
  ])
})
