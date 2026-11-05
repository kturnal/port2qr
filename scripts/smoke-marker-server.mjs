// Disposable loopback server for the Quick Tunnel smoke test. It serves only a random,
// nonsensitive marker.
import {writeFileSync} from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const marker = process.env.PORT2QR_SMOKE_MARKER
const port = Number(process.env.PORT2QR_SMOKE_PORT)
const stateDir = process.env.PORT2QR_SMOKE_STATE_DIR
if (!marker || !Number.isInteger(port) || !stateDir) {
  throw new Error('PORT2QR_SMOKE_MARKER, PORT2QR_SMOKE_PORT and PORT2QR_SMOKE_STATE_DIR are required.')
}

writeFileSync(path.join(stateDir, 'origin.pid'), `${process.pid}\n`)

const server = http.createServer((_request, response) => {
  response.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'})
  response.end(`${marker}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 250).unref()
  })
}

server.listen(port, '127.0.0.1')
