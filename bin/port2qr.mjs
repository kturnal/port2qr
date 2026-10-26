#!/usr/bin/env node

import {spawn} from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {createRequire} from 'node:module'
import qrcode from 'qrcode-terminal'
import {HELP, parseArgs} from '../src/options.mjs'
import {spawnProcessTree, stopProcessTree, stopProcessTreeSync} from '../src/process-tree.mjs'
import {findQuickTunnelUrl} from '../src/tunnel-url.mjs'

const require = createRequire(import.meta.url)
const {version} = require('../package.json')
const isWindows = process.platform === 'win32'
const children = new Set()
let shuttingDown = false
let cancellationReason
let recentTunnelOutput = ''
let rejectUnexpectedExit
let resolveStop

class StopRequestedError extends Error {}

const unexpectedExit = new Promise((_, reject) => {
  rejectUnexpectedExit = reject
})
unexpectedExit.catch(() => {})

const stopRequested = new Promise(resolve => {
  resolveStop = resolve
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.once(signal, () => {
    shuttingDown = true
    cancellationReason ??= new StopRequestedError()
    resolveStop(signal)
  })
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function throwIfCancelled() {
  if (cancellationReason) throw cancellationReason
}

async function raceWithStop(promise) {
  const stopped = Symbol('stopped')
  const result = await Promise.race([
    promise,
    unexpectedExit,
    stopRequested.then(() => stopped),
  ])
  if (result === stopped) throw cancellationReason ?? new StopRequestedError()
  return result
}

function describeExit(label, code, signal) {
  const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
  return new Error(`${label} exited unexpectedly (${reason}).`)
}

function monitor(child, label) {
  children.add(child)
  child.once('error', error => {
    if (!shuttingDown) {
      cancellationReason ??= new Error(`${label} could not start: ${error.message}`)
      rejectUnexpectedExit(cancellationReason)
    }
  })
  child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      cancellationReason ??= describeExit(label, code, signal)
      rejectUnexpectedExit(cancellationReason)
    }
  })
}

async function verifyCloudflared() {
  await new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['--version'], {stdio: 'ignore'})
    let settled = false
    const finish = callback => value => {
      if (settled) return
      settled = true
      callback(value)
    }

    child.once('error', finish(error => {
      if (error.code === 'ENOENT') {
        reject(new Error('cloudflared is not installed or is not on PATH. See: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'))
      } else {
        reject(new Error(`Could not run cloudflared: ${error.message}`))
      }
    }))
    child.once('exit', finish(code => {
      if (code === 0) resolve()
      else reject(new Error(`cloudflared --version exited with code ${code}.`))
    }))
  })

  const configNames = ['config.yml', 'config.yaml']
  const configDir = path.join(os.homedir(), '.cloudflared')
  const existingConfig = configNames.find(name => fs.existsSync(path.join(configDir, name)))
  if (existingConfig) {
    throw new Error(
      `Cloudflare Quick Tunnels do not support ~/.cloudflared/${existingConfig}. ` +
      'Temporarily move that file, then run port2qr again.'
    )
  }
}

function requestOrigin(origin) {
  return new Promise(resolve => {
    const client = origin.protocol === 'https:' ? https : http
    const request = client.get(origin, response => {
      response.resume()
      resolve(response.statusCode >= 200 && response.statusCode < 500)
    })
    request.setTimeout(1_000, () => request.destroy())
    request.once('error', () => resolve(false))
  })
}

async function waitForOrigin(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfCancelled()
    if (await requestOrigin(origin)) return
    throwIfCancelled()
    await delay(250)
  }
  throw new Error(`The origin did not become ready at ${origin.href} within ${timeoutMs / 1_000} seconds.`)
}

function startCommand(command) {
  if (command.length === 0) return null
  const executable = isWindows && command[0] === 'npm' ? 'npm.cmd' : command[0]
  console.log(`Starting local command: ${command[0]} (${command.length - 1} argument(s))`)
  const child = spawnProcessTree(executable, command.slice(1), {stdio: 'inherit'})
  monitor(child, 'Local command')
  return child
}

function startTunnel(origin, hostHeader) {
  const args = ['tunnel', '--url', origin.href]
  if (hostHeader) args.push('--http-host-header', hostHeader)
  args.push('--no-autoupdate')

  console.log('Starting a temporary Cloudflare Quick Tunnel ...')
  const child = spawnProcessTree('cloudflared', args, {stdio: ['ignore', 'pipe', 'pipe']})
  monitor(child, 'Cloudflare Tunnel')
  return child
}

function rememberTunnelOutput(chunk) {
  recentTunnelOutput = `${recentTunnelOutput}${chunk}`.slice(-16_000)
  return findQuickTunnelUrl(recentTunnelOutput)
}

function waitForTunnelUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Cloudflare did not provide a Quick Tunnel URL within ${timeoutMs / 1_000} seconds.`))
    }, timeoutMs)
    timeout.unref()

    const inspect = chunk => {
      if (settled) return
      const url = rememberTunnelOutput(chunk.toString())
      if (!url) return
      settled = true
      clearTimeout(timeout)
      resolve(url)
    }

    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
  })
}

function renderQr(url) {
  console.log('\nWARNING: This URL is public to anyone who has it while port2qr is running.')
  console.log(`\n${url}\n`)
  qrcode.generate(url, {small: true}, qr => process.stdout.write(`${qr}\n`))
  console.log('Scan the QR code on your phone. Press Ctrl+C to stop the tunnel and expire the URL.')
}

function stopChildrenSynchronously() {
  shuttingDown = true
  for (const child of children) {
    try {
      stopProcessTreeSync(child)
    } catch {
      // Best effort during process exit; async cleanup handles normal exits.
    }
  }
}

process.once('exit', stopChildrenSynchronously)

async function run(options) {
  let commandProcess
  let tunnelProcess
  let failed = false
  try {
    await verifyCloudflared()
    throwIfCancelled()

    if (options.command.length > 0 && await requestOrigin(options.origin)) {
      throw new Error(`The origin is already responding at ${options.origin.href}; omit the command after -- to tunnel it.`)
    }
    commandProcess = startCommand(options.command)
    await raceWithStop(waitForOrigin(options.origin, options.timeoutMs))

    tunnelProcess = startTunnel(options.origin, options.hostHeader)
    const url = await raceWithStop(waitForTunnelUrl(tunnelProcess, options.timeoutMs))
    renderQr(url)

    await Promise.race([stopRequested, unexpectedExit])
  } catch (error) {
    if (!(error instanceof StopRequestedError)) {
      failed = true
      console.error(`\nport2qr: ${error.message}`)
      if (recentTunnelOutput.trim()) {
        console.error('\nRecent cloudflared output:')
        console.error(recentTunnelOutput.trim())
      }
    }
  } finally {
    shuttingDown = true
    if (!failed) console.log('\nStopping port2qr ...')
    await Promise.all([stopProcessTree(tunnelProcess), stopProcessTree(commandProcess)])
    process.exitCode = failed ? 1 : 0
  }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`port2qr: ${error.message}`)
  console.error('Run port2qr --help for usage.')
  process.exitCode = 1
}

if (options?.action === 'help') console.log(HELP)
else if (options?.action === 'version') console.log(version)
else if (options?.action === 'run') await run(options)
