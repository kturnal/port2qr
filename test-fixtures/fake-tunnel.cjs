const {mkdirSync, writeFileSync} = require('node:fs')
const path = require('node:path')
const process = require('node:process')

const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('cloudflared version test-fixture\n')
  process.exit(0)
}
if (args[0] !== 'tunnel') {
  throw new Error(`Unexpected fake cloudflared command: ${args.join(' ')}`)
}

const stateDir = process.env.PORT2QR_TEST_STATE_DIR
if (!stateDir) throw new Error('PORT2QR_TEST_STATE_DIR is required')

mkdirSync(stateDir, {recursive: true})
writeFileSync(path.join(stateDir, 'tunnel.pid'), `${process.pid}\n`)
writeFileSync(
  path.join(stateDir, 'tunnel-args.json'),
  `${JSON.stringify(args)}\n`
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

if (mode === 'url' || mode === 'exit') {
  const url = process.env.PORT2QR_FAKE_TUNNEL_URL ??
    'https://deterministic-test.trycloudflare.com'
  setTimeout(() => {
    process.stderr.write(`INF Your quick Tunnel has been created! ${url}\n`)
    if (mode === 'exit') {
      const exitDelayMs = Number(process.env.PORT2QR_FAKE_TUNNEL_EXIT_DELAY_MS ?? 250)
      setTimeout(() => {
        process.exit(Number(process.env.PORT2QR_FAKE_TUNNEL_EXIT_CODE ?? 18))
      }, exitDelayMs)
    }
  }, delayMs)
} else if (mode === 'fail') {
  setTimeout(() => {
    process.stderr.write('ERR simulated cloudflared failure\n')
    process.exit(Number(process.env.PORT2QR_FAKE_TUNNEL_EXIT_CODE ?? 17))
  }, delayMs)
} else if (mode !== 'delay') {
  throw new Error(`Unknown fake tunnel mode: ${mode}`)
}

setInterval(() => {}, 1_000)
