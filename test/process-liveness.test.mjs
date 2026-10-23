import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import {
  processGroupIsRunning,
  processIsRunning,
  procfsProcessGroupIsLive,
  procfsProcessIsLive,
} from '../src/process-liveness.mjs'

const linuxTest = process.platform === 'linux' ? test : test.skip

function writeStat(root, entry, {pid = Number(entry), comm = 'node', state, pgrp}) {
  mkdirSync(path.join(root, String(entry)), {recursive: true})
  writeFileSync(
    path.join(root, String(entry), 'stat'),
    `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1 4194560 0 0 0 0\n`
  )
}

function createProcfs(t, processes, {selfPid = process.pid} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'port2qr-procfs-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  writeStat(root, 'self', {pid: selfPid, state: 'R', pgrp: selfPid})
  for (const stat of processes) writeStat(root, stat.pid, stat)
  return root
}

test('treats a process group whose members are all zombies as stopped', t => {
  const procRoot = createProcfs(t, [
    {pid: 100, state: 'Z', pgrp: 100},
    {pid: 101, state: 'Z', pgrp: 100},
    {pid: 200, state: 'S', pgrp: 200},
  ])

  assert.equal(procfsProcessGroupIsLive(100, procRoot), false)
})

test('treats a process group with any live member as running', t => {
  const procRoot = createProcfs(t, [
    {pid: 100, state: 'Z', pgrp: 100},
    {pid: 101, state: 'S', pgrp: 100},
    {pid: 102, state: 'Z', pgrp: 100},
  ])

  assert.equal(procfsProcessGroupIsLive(100, procRoot), true)
})

test('reads single process states from procfs', t => {
  const procRoot = createProcfs(t, [
    {pid: 100, state: 'Z', pgrp: 100},
    {pid: 101, state: 'S', pgrp: 100},
    {pid: 102, state: 'D', pgrp: 100},
  ])

  assert.equal(procfsProcessIsLive(100, procRoot), false)
  assert.equal(procfsProcessIsLive(101, procRoot), true)
  assert.equal(procfsProcessIsLive(102, procRoot), true)
  assert.equal(procfsProcessIsLive(103, procRoot), false, 'a reaped process is not live')
})

test('parses command names containing spaces and parentheses', t => {
  const procRoot = createProcfs(t, [
    {pid: 100, state: 'Z', pgrp: 100},
    // Parsing up to the first ")" would read this as a live member of group 100.
    {pid: 101, comm: 'x) S 1 100 (y', state: 'Z', pgrp: 300},
  ])

  assert.equal(procfsProcessGroupIsLive(100, procRoot), false)
  assert.equal(procfsProcessGroupIsLive(300, procRoot), false)
  assert.equal(procfsProcessIsLive(101, procRoot), false)
})

test('defers to kill(2) when procfs cannot tell', t => {
  const otherNamespace = createProcfs(t, [{pid: 100, state: 'Z', pgrp: 100}], {
    selfPid: process.pid + 1,
  })
  assert.equal(procfsProcessIsLive(100, otherNamespace), undefined)
  assert.equal(procfsProcessGroupIsLive(100, otherNamespace), undefined)

  const missing = path.join(otherNamespace, 'missing')
  assert.equal(procfsProcessIsLive(100, missing), undefined)
  assert.equal(procfsProcessGroupIsLive(100, missing), undefined)

  const hiddenGroup = createProcfs(t, [{pid: 100, state: 'S', pgrp: 100}])
  assert.equal(procfsProcessGroupIsLive(400, hiddenGroup), undefined)

  const malformed = createProcfs(t, [
    {pid: 100, state: 'Z', pgrp: 100},
    {pid: 101, state: 'Z', pgrp: 100},
  ])
  writeFileSync(path.join(malformed, '101', 'stat'), 'unexpected\n')
  assert.equal(procfsProcessGroupIsLive(100, malformed), undefined)
})

async function readLine(stream) {
  stream.setEncoding('utf8')
  let output = ''
  for await (const chunk of stream) {
    output += chunk
    const newline = output.indexOf('\n')
    if (newline !== -1) return output.slice(0, newline)
  }
  throw new Error(`Output ended before a complete line: ${output}`)
}

function procState(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').match(/\) (\S) \d+ \d+ /)[1]
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function waitForState(pid, states) {
  const deadline = Date.now() + 5_000
  while (!states.includes(procState(pid))) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for process ${pid} to reach ${states.map(String).join(' or ')}.`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function killGroup(pgid) {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

// The parent execs into sleep, which never reaps, so killed children in the new session
// stay zombies like orphans under a non-reaping PID 1.
async function startSessionUnderNonReapingParent(t, script) {
  const parent = spawn('sh', ['-c', `setsid sh -c '${script}' & exec sleep 30`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => parent.kill('SIGKILL'))
  const pids = (await readLine(parent.stdout)).split(' ').map(Number)
  t.after(() => killGroup(pids[0]))
  return pids
}

linuxTest('detects a real process group that contains only a zombie', async t => {
  const [leader] = await startSessionUnderNonReapingParent(t, 'echo $$; exec sleep 30')
  assert.equal(processIsRunning(leader), true)
  assert.equal(processGroupIsRunning(leader), true)

  process.kill(leader, 'SIGKILL')
  await waitForState(leader, ['Z'])

  assert.doesNotThrow(() => process.kill(-leader, 0), 'kill(2) still reaches the zombie')
  assert.equal(processIsRunning(leader), false)
  assert.equal(processGroupIsRunning(leader), false)
})

linuxTest('keeps a real process group running while any member is alive', async t => {
  const [leader, member] = await startSessionUnderNonReapingParent(
    t,
    'sleep 30 & echo $$ $!; exec sleep 30'
  )

  process.kill(leader, 'SIGKILL')
  await waitForState(leader, ['Z'])
  assert.equal(processIsRunning(leader), false)
  assert.equal(processIsRunning(member), true)
  assert.equal(processGroupIsRunning(leader), true)

  process.kill(member, 'SIGKILL')
  await waitForState(member, [null, 'Z'])
  assert.equal(processGroupIsRunning(leader), false)
})
