import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// kill(pid, 0) succeeds for zombies as well as live processes. When PID 1 does not reap
// orphans (for example in a container started without an init process), stopped
// descendants can stay zombies indefinitely, so on Linux procfs decides whether a
// process that still accepts signals is actually alive.

// The command name is parenthesised and may itself contain spaces or parentheses, so the
// greedy match anchors on the last ") " that is followed by the state, ppid, and pgrp.
const PROC_STAT = /^(\d+) \(.*\) (\S) \d+ (\d+) /s

function readProcStat(procRoot, entry) {
  const statPath = path.join(procRoot, String(entry), 'stat')
  let contents
  try {
    contents = fs.readFileSync(statPath, 'utf8')
  } catch (error) {
    // The process was reaped after it was probed or listed.
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
    throw error
  }
  const match = PROC_STAT.exec(contents)
  if (!match) throw new Error(`Unrecognized format in ${statPath}.`)
  return {pid: Number(match[1]), state: match[2], pgrp: Number(match[3])}
}

const isLive = stat => stat.state !== 'Z' && stat.state !== 'X'

// A procfs mounted for another PID namespace numbers processes differently.
function procfsMatchesPidNamespace(procRoot) {
  return readProcStat(procRoot, 'self')?.pid === process.pid
}

// Returns whether procfs shows the process as alive, or undefined when procfs cannot tell.
export function procfsProcessIsLive(pid, procRoot = '/proc') {
  try {
    if (!procfsMatchesPidNamespace(procRoot)) return undefined
    const stat = readProcStat(procRoot, pid)
    return stat ? isLive(stat) : false
  } catch {
    return undefined
  }
}

// Returns whether procfs shows any live member of the process group, or undefined when
// procfs cannot tell.
export function procfsProcessGroupIsLive(pgid, procRoot = '/proc') {
  try {
    if (!procfsMatchesPidNamespace(procRoot)) return undefined
    let foundMember = false
    for (const entry of fs.readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue
      const stat = readProcStat(procRoot, entry)
      if (stat?.pgrp !== pgid) continue
      if (isLive(stat)) return true
      foundMember = true
    }
    // Finding no member at all means procfs is hiding the group (for example with
    // hidepid) or it was reaped meanwhile; either way, let kill(2) decide.
    return foundMember ? false : undefined
  } catch {
    return undefined
  }
}

function signalReaches(target) {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

export function processIsRunning(pid) {
  if (!signalReaches(pid)) return false
  if (process.platform !== 'linux') return true
  return procfsProcessIsLive(pid) ?? true
}

export function processGroupIsRunning(pgid) {
  if (!signalReaches(-pgid)) return false
  if (process.platform !== 'linux') return true
  return procfsProcessGroupIsLive(pgid) ?? true
}
