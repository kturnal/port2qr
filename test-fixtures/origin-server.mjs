import {spawn} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const stateDir = process.env.PORT2QR_TEST_STATE_DIR
const port = Number(process.env.PORT2QR_ORIGIN_PORT)
if (!stateDir) throw new Error('PORT2QR_TEST_STATE_DIR is required')
if (!Number.isInteger(port) || port < 1) throw new Error('PORT2QR_ORIGIN_PORT is required')

mkdirSync(stateDir, {recursive: true})
writeFileSync(path.join(stateDir, 'origin.pid'), `${process.pid}\n`)
writeFileSync(
  path.join(stateDir, 'origin-args.json'),
  `${JSON.stringify(process.argv.slice(2))}\n`
)

if (process.env.PORT2QR_ORIGIN_SPAWN_CHILD === '1') {
  // On Windows, Node ends the children it did not detach when it exits. Detaching keeps the
  // descendant alive past this process, like the Node process that npm.cmd starts.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform === 'win32',
    stdio: 'ignore',
  })
  writeFileSync(path.join(stateDir, 'origin-child.pid'), `${child.pid}\n`)
}

const server = http.createServer((_request, response) => {
  response.writeHead(204)
  response.end()
})

let stopping = false
function stop(signal) {
  if (stopping) return
  stopping = true
  writeFileSync(path.join(stateDir, 'origin-stopped'), `${signal}\n`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 250).unref()
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => stop(signal))
}

const exitCode = process.env.PORT2QR_ORIGIN_EXIT_CODE
if (exitCode !== undefined) {
  setTimeout(() => process.exit(Number(exitCode)), 25)
} else {
  const delayMs = Number(process.env.PORT2QR_ORIGIN_DELAY_MS ?? 0)
  setTimeout(() => {
    server.listen(port, '127.0.0.1', () => {
      writeFileSync(path.join(stateDir, 'origin-ready'), `${port}\n`)
    })
  }, delayMs)
}
