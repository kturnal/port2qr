import {execFile, spawn, spawnSync} from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import {processGroupIsRunning} from './process-liveness.mjs'

// POSIX children lead their own process group, so signalling the group reaches every
// descendant. Windows has no process groups that Node can signal: child.kill() terminates
// only the immediate process, which leaves descendants such as the Node process started by
// npm.cmd running. There, taskkill /T ends the tree that is still linked to a live root, and
// children that outlived a root which had already exited are found by their parent PID.

const isWindows = process.platform === 'win32'
const GRACEFUL_STOP_MS = 3_000
const FORCED_STOP_MS = 1_000
const WINDOWS_TOOL_TIMEOUT_MS = 10_000
// Allows for coarse clocks when comparing process creation times with Date.now().
const CLOCK_TOLERANCE_MS = 1_000

const lifetimes = new WeakMap()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export function spawnProcessTree(command, args, options) {
  const lifetime = {startedAt: Date.now(), exitedAt: undefined}
  const child = spawn(command, args, {...options, detached: !isWindows})
  lifetimes.set(child, lifetime)
  child.once('exit', () => { lifetime.exitedAt = Date.now() })
  return child
}

const hasStarted = child => child?.pid !== undefined
const rootIsRunning = child => child.exitCode === null && child.signalCode === null

function signalGroup(child, signal) {
  if (!processGroupIsRunning(child.pid)) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function waitWhile(isRunning, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (isRunning() && Date.now() < deadline) await delay(50)
}

async function stopProcessGroup(child) {
  if (!processGroupIsRunning(child.pid)) return
  signalGroup(child, 'SIGTERM')
  await waitWhile(() => processGroupIsRunning(child.pid), GRACEFUL_STOP_MS)
  if (processGroupIsRunning(child.pid)) {
    signalGroup(child, 'SIGKILL')
    await waitWhile(() => processGroupIsRunning(child.pid), FORCED_STOP_MS)
  }
}

// Resolved from the system directory because Windows searches the working directory before
// PATH for a bare executable name.
function systemExecutable(...segments) {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return path.join(systemRoot, 'System32', ...segments)
}

function runWindowsTool(file, args) {
  return new Promise(resolve => {
    execFile(file, args, {
      timeout: WINDOWS_TOOL_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => resolve({ok: !error, stdout}))
  })
}

function taskkillArgs(pids) {
  return [...pids.flatMap(pid => ['/PID', String(pid)]), '/T', '/F']
}

// Prints "<pid> <creation time in Unix milliseconds>" for each child of the given process.
function childProcessQuery(pid) {
  return `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | ` +
    'Where-Object CreationDate | ForEach-Object { ' +
    "'{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"
}

// A process keeps the PID of a parent that has exited, and Windows can reuse that PID, so only
// children created while the parent was running belong to it.
export function findOrphanedChildren(output, {startedAt, exitedAt}) {
  const pids = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+) (\d+)$/.exec(line.trim())
    if (!match) continue
    const createdAt = Number(match[2])
    if (createdAt < startedAt - CLOCK_TOLERANCE_MS) continue
    if (createdAt > exitedAt + CLOCK_TOLERANCE_MS) continue
    pids.push(Number(match[1]))
  }
  return pids
}

async function stopOrphanedChildren(child) {
  const lifetime = lifetimes.get(child)
  if (!lifetime) return
  const script = Buffer.from(childProcessQuery(child.pid), 'utf16le').toString('base64')
  const {ok, stdout} = await runWindowsTool(
    systemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script]
  )
  if (!ok) return
  const pids = findOrphanedChildren(stdout, {
    startedAt: lifetime.startedAt,
    exitedAt: lifetime.exitedAt ?? Date.now(),
  })
  if (pids.length > 0) await runWindowsTool(systemExecutable('taskkill.exe'), taskkillArgs(pids))
}

// Windows has no signal that asks a console process to exit; Ctrl+C already reaches every
// process attached to the console. The tree is ended at once, before an intermediate process
// can exit and detach its descendants from the root.
async function stopWindowsProcessTree(child) {
  let treeStopped = false
  if (rootIsRunning(child)) {
    treeStopped = (await runWindowsTool(systemExecutable('taskkill.exe'), taskkillArgs([child.pid]))).ok
    await waitWhile(() => rootIsRunning(child), FORCED_STOP_MS)
  }
  if (rootIsRunning(child)) {
    // TerminateProcess through the handle libuv holds, which a reused PID cannot redirect.
    child.kill('SIGKILL')
    await waitWhile(() => rootIsRunning(child), FORCED_STOP_MS)
  }
  if (!treeStopped) await stopOrphanedChildren(child)
}

export async function stopProcessTree(child) {
  if (!hasStarted(child)) return
  if (isWindows) await stopWindowsProcessTree(child)
  else await stopProcessGroup(child)
}

// Best effort for process exit, where only synchronous work runs.
export function stopProcessTreeSync(child) {
  if (!hasStarted(child)) return
  if (!isWindows) {
    signalGroup(child, 'SIGTERM')
    return
  }
  if (!rootIsRunning(child)) return
  const result = spawnSync(systemExecutable('taskkill.exe'), taskkillArgs([child.pid]), {
    stdio: 'ignore',
    timeout: WINDOWS_TOOL_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) child.kill('SIGKILL')
}
