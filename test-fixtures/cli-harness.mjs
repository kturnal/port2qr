import {spawn} from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {
  processGroupIsRunning as posixProcessGroupIsRunning,
  processIsRunning,
} from '../src/process-liveness.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = path.join(packageRoot, 'bin', 'port2qr.mjs')
const fakeTunnelPath = fileURLToPath(new URL('./fake-tunnel.cjs', import.meta.url))

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message())), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timeout)
        resolve(value)
      },
      error => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

async function waitUntil(check, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function matches(value, expected) {
  if (typeof expected === 'string') return value.includes(expected)
  return expected.test(value)
}

function processGroupIsRunning(pid) {
  if (process.platform === 'win32') return processIsRunning(pid)
  return posixProcessGroupIsRunning(pid)
}

async function installFakeCloudflared(binDir) {
  const executableName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const executablePath = path.join(binDir, executableName)

  if (process.platform === 'win32') {
    throw new Error('fake cloudflared is not implemented on Windows yet (see issue #4)')
  }

  // The explicit shim makes the fake independent of the CLI cwd and lets it
  // observe both the --version probe and the complete tunnel command line.
  await writeFile(executablePath, [
    '#!/bin/sh',
    'exec "$PORT2QR_TEST_NODE_PATH" "$PORT2QR_TEST_FAKE_TUNNEL_PATH" "$@"',
    '',
  ].join('\n'))
  await chmod(executablePath, 0o755)
}

async function forceStopProcessGroup(pid) {
  if (!processGroupIsRunning(pid)) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

export async function createCliHarness(t, {fakeCloudflared = true} = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'port2qr-lifecycle-'))
  const homeDir = path.join(tempRoot, 'home')
  const binDir = path.join(tempRoot, 'bin')
  const stateDir = path.join(tempRoot, 'state')
  await Promise.all([
    mkdir(homeDir, {recursive: true}),
    mkdir(binDir, {recursive: true}),
    mkdir(stateDir, {recursive: true}),
  ])
  if (fakeCloudflared) await installFakeCloudflared(binDir)

  const runs = new Set()
  const baseEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    PORT2QR_TEST_FAKE_TUNNEL_PATH: fakeTunnelPath,
    PORT2QR_TEST_NODE_PATH: process.execPath,
    PORT2QR_TEST_STATE_DIR: stateDir,
  }

  function start(args, env = {}) {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: tempRoot,
      env: {...baseEnv, ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = {stdout: '', stderr: ''}
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { output.stdout += chunk })
    child.stderr.on('data', chunk => { output.stderr += chunk })

    const completion = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({code, signal}))
    })
    completion.catch(() => {})

    const run = {
      child,
      get stderr() { return output.stderr },
      get stdout() { return output.stdout },
      signal(signal) { child.kill(signal) },
      waitForExit(timeoutMs = 8_000) {
        return withTimeout(
          completion,
          timeoutMs,
          () => `CLI did not exit within ${timeoutMs}ms.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`
        )
      },
      waitForOutput(expected, timeoutMs = 5_000) {
        return waitUntil(
          () => matches(`${output.stdout}\n${output.stderr}`, expected),
          `CLI output matching ${expected}`,
          timeoutMs
        )
      },
    }
    runs.add(run)
    completion.finally(() => runs.delete(run)).catch(() => {})
    return run
  }

  async function readState(name) {
    return readFile(path.join(stateDir, name), 'utf8')
  }

  async function readStateJson(name) {
    return JSON.parse(await readState(name))
  }

  async function waitForState(name, timeoutMs = 5_000) {
    const filePath = path.join(stateDir, name)
    await waitUntil(async () => {
      try {
        await stat(filePath)
        return true
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    }, `${name} to be written`, timeoutMs)
    return filePath
  }

  async function stateExists(name) {
    try {
      await stat(path.join(stateDir, name))
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  async function assertProcessStopped(pidFile) {
    await waitForState(pidFile)
    const pid = Number((await readState(pidFile)).trim())
    await waitUntil(
      () => !processGroupIsRunning(pid),
      `process group ${pid} from ${pidFile} to stop`
    )
    return pid
  }

  async function assertPidStopped(pidFile) {
    await waitForState(pidFile)
    const pid = Number((await readState(pidFile)).trim())
    await waitUntil(() => !processIsRunning(pid), `process ${pid} from ${pidFile} to stop`)
    return pid
  }

  t.after(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        run.child.kill('SIGKILL')
      }
    }
    for (const pidFile of ['origin.pid', 'tunnel.pid']) {
      if (!await stateExists(pidFile)) continue
      const pid = Number((await readState(pidFile)).trim())
      await forceStopProcessGroup(pid)
    }
    await rm(tempRoot, {recursive: true, force: true})
  })

  return {
    binDir,
    homeDir,
    readState,
    readStateJson,
    start,
    stateDir,
    stateExists,
    waitForState,
    assertProcessStopped,
    assertPidStopped,
  }
}

export const originFixturePath = fileURLToPath(
  new URL('./origin-server.mjs', import.meta.url)
)
