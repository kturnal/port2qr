import {execFile, spawn, spawnSync} from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import {processGroupIsRunning} from './process-liveness.mjs'

// POSIX children lead their own process group, so signalling the group reaches every
// descendant. Windows has no process groups that outlive their leader; there the tree is
// stopped with taskkill /T, which follows parent links from a running root, and children
// orphaned by a root that already exited are found by their recorded parent PID.

const isWindows = process.platform === 'win32'
const GRACEFUL_STOP_MS = 3_000
const FORCED_STOP_MS = 1_000
const ORPHAN_QUERY_TIMEOUT_MS = 10_000
// Process creation times and Date.now() come from the same clock, but allow for rounding.
const CREATION_TIME_TOLERANCE_MS = 1_000
const startTimes = new WeakMap()

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function systemExecutable(...segments) {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...segments)
}

export function spawnProcessTree(file, args, options) {
  const startedAt = Date.now()
  const child = spawn(file, args, {...options, detached: !isWindows})
  startTimes.set(child, startedAt)
  return child
}

function rootIsRunning(child) {
  return Boolean(child?.pid) && child.exitCode === null && child.signalCode === null
}

export function processTreeIsRunning(child) {
  if (!child?.pid) return false
  if (isWindows) return rootIsRunning(child)
  return processGroupIsRunning(child.pid)
}

function signalProcessGroup(child, signal) {
  if (!processTreeIsRunning(child)) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

const taskkillArgs = pid => ['/PID', String(pid), '/T', '/F']

function taskkill(pid) {
  return new Promise(resolve => {
    // A non-zero exit usually means the tree exited meanwhile; the caller verifies the root.
    execFile(systemExecutable('taskkill.exe'), taskkillArgs(pid), {windowsHide: true}, () => resolve())
  })
}

// Parses "<pid> <creation time in ms>" lines and keeps processes started after the root.
export function parseOrphanedChildren(output, startedAt) {
  const pids = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+) (\d+)$/.exec(line.trim())
    if (match && Number(match[2]) >= startedAt - CREATION_TIME_TOLERANCE_MS) {
      pids.push(Number(match[1]))
    }
  }
  return pids
}

// Lists processes whose recorded parent is the exited root. The creation-time filter
// excludes children of an unrelated process that later reused the root's PID.
function findOrphanedChildren(child) {
  const startedAt = startTimes.get(child)
  if (startedAt === undefined || !Number.isInteger(child.pid)) return Promise.resolve([])
  const script = [
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' |`,
    'Where-Object { $_.CreationDate } |',
    "ForEach-Object { '{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }",
  ].join(' ')
  return new Promise(resolve => {
    execFile(
      systemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {timeout: ORPHAN_QUERY_TIMEOUT_MS, windowsHide: true},
      (error, stdout) => resolve(error ? [] : parseOrphanedChildren(stdout, startedAt))
    )
  })
}

async function waitForRootExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (rootIsRunning(child) && Date.now() < deadline) await delay(50)
}

async function stopWindowsProcessTree(child) {
  // Windows has no catchable termination signal for console programs, so stopping is forced,
  // as child.kill() already was.
  const roots = rootIsRunning(child) ? [child.pid] : await findOrphanedChildren(child)
  await Promise.all(roots.map(taskkill))
  await waitForRootExit(child, FORCED_STOP_MS)
  if (rootIsRunning(child)) {
    child.kill('SIGKILL')
    await waitForRootExit(child, FORCED_STOP_MS)
  }
}

async function stopPosixProcessTree(child) {
  if (!processTreeIsRunning(child)) return
  signalProcessGroup(child, 'SIGTERM')
  const deadline = Date.now() + GRACEFUL_STOP_MS
  while (processTreeIsRunning(child) && Date.now() < deadline) await delay(50)
  if (processTreeIsRunning(child)) {
    signalProcessGroup(child, 'SIGKILL')
    const killDeadline = Date.now() + FORCED_STOP_MS
    while (processTreeIsRunning(child) && Date.now() < killDeadline) await delay(50)
  }
}

// Stops a child and its descendants within a bounded time.
export async function stopProcessTree(child) {
  if (!child?.pid) return
  if (isWindows) await stopWindowsProcessTree(child)
  else await stopPosixProcessTree(child)
}

// Best-effort synchronous cleanup for process exit, when asynchronous work cannot run.
export function stopProcessTreeSync(child) {
  if (!processTreeIsRunning(child)) return
  if (isWindows) {
    spawnSync(systemExecutable('taskkill.exe'), taskkillArgs(child.pid), {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    signalProcessGroup(child, 'SIGTERM')
  }
}
