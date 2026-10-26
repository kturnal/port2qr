import {execFile, spawn} from 'node:child_process'
import {
  chmod,
  copyFile,
  link,
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
import {fileURLToPath, pathToFileURL} from 'node:url'
import {
  processGroupIsRunning as posixProcessGroupIsRunning,
  processIsRunning,
} from '../src/process-liveness.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = path.join(packageRoot, 'bin', 'port2qr.mjs')
const fakeTunnelPath = fileURLToPath(new URL('./fake-tunnel.cjs', import.meta.url))
const signalBridgePath = fileURLToPath(new URL('./signal-bridge.cjs', import.meta.url))
const isWindows = process.platform === 'win32'

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
  if (isWindows) return processIsRunning(pid)
  return posixProcessGroupIsRunning(pid)
}

async function installFakeCloudflared(binDir, cliWorkingDir) {
  if (isWindows) {
    // Without a shell, Windows starts only .exe files, so the fake is Node linked as
    // cloudflared.exe. `cloudflared --version` prints Node's version, and `cloudflared tunnel`
    // runs the script named tunnel in the CLI's working directory, which loads the fake.
    const executablePath = path.join(binDir, 'cloudflared.exe')
    try {
      await link(process.execPath, executablePath)
    } catch {
      await copyFile(process.execPath, executablePath)
    }
    await writeFile(path.join(cliWorkingDir, 'tunnel'), [
      "process.argv.splice(2, 0, 'tunnel')",
      `import(${JSON.stringify(pathToFileURL(fakeTunnelPath).href)})`,
      '',
    ].join('\n'))
    return
  }

  // The explicit shim makes the fake independent of the CLI cwd and lets it
  // observe both the --version probe and the complete tunnel command line.
  const executablePath = path.join(binDir, 'cloudflared')
  await writeFile(executablePath, [
    '#!/bin/sh',
    'exec "$PORT2QR_TEST_NODE_PATH" "$PORT2QR_TEST_FAKE_TUNNEL_PATH" "$@"',
    '',
  ].join('\n'))
  await chmod(executablePath, 0o755)
}

async function forceStopProcessTree(pid) {
  if (isWindows) {
    if (!processIsRunning(pid)) return
    await new Promise(resolve => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true}, () => resolve())
    })
    return
  }
  if (!posixProcessGroupIsRunning(pid)) return
  try {
    process.kill(-pid, 'SIGKILL')
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
  if (fakeCloudflared) await installFakeCloudflared(binDir, tempRoot)

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
    // child.kill() terminates a Windows process outright, so there signals are relayed over
    // IPC to a preloaded module that emits them in the CLI.
    const nodeArgs = isWindows ? ['--require', signalBridgePath, cliPath] : [cliPath]
    const child = spawn(process.execPath, [...nodeArgs, ...args], {
      cwd: tempRoot,
      env: {...baseEnv, ...env},
      stdio: isWindows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
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
      signal(signal) {
        if (isWindows) child.send({signal})
        else child.kill(signal)
      },
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
    // On Windows the origin's child is outside any group and can outlive the origin.
    for (const pidFile of ['origin.pid', 'origin-child.pid', 'tunnel.pid']) {
      if (!await stateExists(pidFile)) continue
      const pid = Number((await readState(pidFile)).trim())
      await forceStopProcessTree(pid)
    }
    // Windows refuses to delete files that exiting processes still hold open.
    await rm(tempRoot, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
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
