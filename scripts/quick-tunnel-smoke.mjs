#!/usr/bin/env node
// Opt-in smoke test against a real Cloudflare Quick Tunnel. It exposes only a disposable
// loopback server that answers with a random marker, fetches the marker through the public
// URL, stops port2qr with SIGINT, and verifies that no owned process remains.
//
// Requires a real cloudflared on PATH and outbound internet access. Run it on Linux or
// macOS; the GitHub Actions workflow is .github/workflows/quick-tunnel-smoke.yml.

import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {processGroupIsRunning} from '../src/process-liveness.mjs'
import {findQuickTunnelUrl} from '../src/tunnel-url.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = path.join(repoRoot, 'bin', 'port2qr.mjs')
const markerServerPath = fileURLToPath(new URL('./smoke-marker-server.mjs', import.meta.url))
const inGitHubActions = process.env.GITHUB_ACTIONS === 'true'
const STARTUP_TIMEOUT_SECONDS = 120
const FETCH_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 15_000

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function log(message) {
  console.log(`[smoke] ${message}`)
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const {port} = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitFor(check, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

// pgrep exits with 1 when nothing matches.
function findProcesses(pattern) {
  return new Promise((resolve, reject) => {
    const child = spawn('pgrep', ['-f', pattern], {stdio: ['ignore', 'pipe', 'inherit']})
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0 && code !== 1) reject(new Error(`pgrep exited with code ${code}.`))
      else resolve(stdout.split('\n').filter(Boolean).map(Number))
    })
  })
}

async function fetchMarker(url, marker) {
  let lastProblem = 'no response yet'
  const found = await waitFor(async () => {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(10_000)})
      const body = await response.text()
      if (response.ok && body.includes(marker)) return true
      lastProblem = `HTTP ${response.status} without the marker`
    } catch (error) {
      // A new Quick Tunnel hostname can take a few seconds to resolve.
      lastProblem = error.cause?.code ?? error.message
    }
    await delay(2_000)
    return false
  }, 'the marker through the public URL', FETCH_TIMEOUT_MS).catch(() => false)
  if (!found) throw new Error(`The public URL never returned the marker (${lastProblem}).`)
}

async function readOriginPid(stateDir) {
  try {
    return Number((await readFile(path.join(stateDir, 'origin.pid'), 'utf8')).trim())
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function verifyCleanup(stateDir, tunnelPattern) {
  const originPid = await readOriginPid(stateDir)
  if (originPid) {
    await waitFor(() => !processGroupIsRunning(originPid), 'the local server to stop', 5_000)
  }
  await waitFor(
    async () => (await findProcesses(tunnelPattern)).length === 0,
    'cloudflared to stop',
    5_000
  )
}

async function main() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'port2qr-smoke-'))
  const marker = `port2qr-smoke-${randomUUID()}`
  const port = await availablePort()
  const tunnelPattern = `cloudflared tunnel --url http://127.0.0.1:${port}/`
  const output = {text: ''}
  let url
  let cli
  let failure

  try {
    log(`Starting port2qr on loopback port ${port} with a disposable marker server.`)
    cli = spawn(process.execPath, [
      cliPath,
      String(port),
      '--timeout',
      String(STARTUP_TIMEOUT_SECONDS),
      '--',
      process.execPath,
      markerServerPath,
    ], {
      env: {
        ...process.env,
        PORT2QR_SMOKE_MARKER: marker,
        PORT2QR_SMOKE_PORT: String(port),
        PORT2QR_SMOKE_STATE_DIR: stateDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise(resolve => cli.once('close', (code, signal) => resolve({code, signal})))

    // The CLI output is kept out of the log until the URL is masked, because the
    // tunnel URL appears in it.
    const capture = chunk => {
      output.text += chunk
      if (url) return
      url = findQuickTunnelUrl(output.text) ?? undefined
      if (url && inGitHubActions) process.stdout.write(`::add-mask::${url}\n`)
    }
    cli.stdout.setEncoding('utf8').on('data', capture)
    cli.stderr.setEncoding('utf8').on('data', capture)

    await waitFor(() => {
      if (cli.exitCode !== null || cli.signalCode !== null) {
        throw new Error(`port2qr exited early (${cli.exitCode ?? cli.signalCode}).`)
      }
      return url && /Scan the QR code/.test(output.text)
    }, 'port2qr to print the Quick Tunnel URL', (STARTUP_TIMEOUT_SECONDS + 10) * 1_000)
    log('port2qr published a Quick Tunnel URL (masked).')

    await fetchMarker(url, marker)
    log('The public URL returned the expected marker.')

    if ((await findProcesses(tunnelPattern)).length === 0) {
      throw new Error('No running cloudflared process was found.')
    }

    cli.kill('SIGINT')
    const result = await Promise.race([exited, delay(STOP_TIMEOUT_MS).then(() => null)])
    if (!result) throw new Error(`port2qr did not exit within ${STOP_TIMEOUT_MS / 1_000} seconds.`)
    if (result.code !== 0) throw new Error(`port2qr exited with code ${result.code} after SIGINT.`)
    log('port2qr exited with code 0 after SIGINT.')
  } catch (error) {
    failure = error
  } finally {
    const running = () => cli && cli.exitCode === null && cli.signalCode === null
    if (running()) {
      cli.kill('SIGINT')
      await waitFor(() => !running(), 'port2qr to exit', STOP_TIMEOUT_MS).catch(() => {
        cli.kill('SIGKILL')
      })
    }
    // Cleanup is verified on success and on failure.
    try {
      await verifyCleanup(stateDir, tunnelPattern)
      log('The local server and cloudflared are no longer running.')
    } catch (error) {
      failure ??= error
      if (failure !== error) console.error(`[smoke] ${error.message}`)
    }
    await rm(stateDir, {recursive: true, force: true})
  }

  if (failure) {
    console.error(`[smoke] FAILED: ${failure.message}`)
    // GitHub Actions masks the URL once it has been seen, but the QR code also encodes it.
    const text = output.text.split('\n').filter(line => !/[█▀▄]/.test(line)).join('\n').trim()
    if (text) console.error(`[smoke] port2qr output (QR code omitted):\n${text}`)
    process.exitCode = 1
  }
}

await main()
