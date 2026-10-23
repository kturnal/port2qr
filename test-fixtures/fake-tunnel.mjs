import {mkdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const stateDir = process.env.PORT2QR_TEST_STATE_DIR
if (!stateDir) throw new Error('PORT2QR_TEST_STATE_DIR is required')

mkdirSync(stateDir, {recursive: true})
writeFileSync(path.join(stateDir, 'tunnel.pid'), `${process.pid}\n`)
writeFileSync(
  path.join(stateDir, 'tunnel-args.json'),
  `${JSON.stringify(process.argv.slice(2))}\n`
)

function stop(signal) {
  writeFileSync(path.join(stateDir, 'tunnel-stopped'), `${signal}\n`)
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => stop(signal))
}

const mode = process.env.PORT2QR_FAKE_TUNNEL_MODE ?? 'url'
const delayMs = Number(process.env.PORT2QR_FAKE_TUNNEL_DELAY_MS ?? 25)

if (mode === 'url') {
  const url = process.env.PORT2QR_FAKE_TUNNEL_URL ??
    'https://deterministic-test.trycloudflare.com'
  setTimeout(() => {
    process.stderr.write(`INF Your quick Tunnel has been created! ${url}\n`)
  }, delayMs)
} else if (mode === 'fail') {
  setTimeout(() => {
    process.stderr.write('ERR simulated cloudflared failure\n')
    process.exit(Number(process.env.PORT2QR_FAKE_TUNNEL_EXIT_CODE ?? 17))
  }, delayMs)
} else if (mode === 'exit') {
  setTimeout(() => {
    process.exit(Number(process.env.PORT2QR_FAKE_TUNNEL_EXIT_CODE ?? 0))
  }, delayMs)
} else if (mode !== 'delay') {
  throw new Error(`Unknown fake tunnel mode: ${mode}`)
}

setInterval(() => {}, 1_000)
