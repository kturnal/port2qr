import {isIP} from 'node:net'

const MIN_PORT = 1
const MAX_PORT = 65_535
const MAX_TIMEOUT_SECONDS = 600

export const HELP = `port2qr — expose a local web server through a temporary HTTPS URL

Usage:
  port2qr <port>
  port2qr <port> -- <command> [args...]
  port2qr --url <origin-url>

Examples:
  port2qr 3000
  port2qr 5173 -- npm run dev
  port2qr --url http://127.0.0.1:8080

Options:
  -p, --port <port>          Local HTTP port (alternative to the positional port)
  -u, --url <url>            Local HTTP or HTTPS origin URL
      --host-header <value>  Host header sent to the local server
      --no-host-header       Preserve the incoming public Host header
  -t, --timeout <seconds>    Origin and tunnel startup timeout (default: 60)
  -h, --help                 Show this help
  -v, --version              Show the version

The generated trycloudflare.com URL is public while this command is running.
Press Ctrl+C to stop the tunnel and expire the URL.`

function valueAfter(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`)
  return value
}

function parsePort(value) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`)
  const port = Number(value)
  if (port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`Port must be between ${MIN_PORT} and ${MAX_PORT}.`)
  }
  return port
}

function parseTimeout(value) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid timeout: ${value}`)
  const seconds = Number(value)
  if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Timeout must be between 1 and ${MAX_TIMEOUT_SECONDS} seconds.`)
  }
  return seconds * 1_000
}

function parseOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid origin URL: ${value}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Origin URL must use http:// or https://.')
  }
  if (url.username || url.password) {
    throw new Error('Origin URL must not contain a username or password.')
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  const isLoopback = hostname === 'localhost' || hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'))
  if (!isLoopback) {
    throw new Error('Origin URL must use localhost, 127.0.0.0/8, or ::1.')
  }
  if (url.pathname !== '/' || url.search) {
    throw new Error('Origin URL must not contain a path or query string.')
  }
  if (url.hash) throw new Error('Origin URL must not contain a fragment.')
  return url
}

function parseHostHeader(value) {
  if (/[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('Host header must not contain whitespace or control characters.')
  }
  return value
}

export function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const optionArgs = separator === -1 ? argv : argv.slice(0, separator)
  const command = separator === -1 ? [] : argv.slice(separator + 1)
  if (separator !== -1 && command.length === 0) throw new Error('Expected a command after --.')

  let port
  let origin
  let hostHeader
  let noHostHeader = false
  let timeoutMs = 60_000
  let positionalPort

  for (let index = 0; index < optionArgs.length; index += 1) {
    const argument = optionArgs[index]
    if (argument === '-h' || argument === '--help') return {action: 'help'}
    if (argument === '-v' || argument === '--version') return {action: 'version'}

    if (argument === '-p' || argument === '--port') {
      port = parsePort(valueAfter(optionArgs, index, argument))
      index += 1
    } else if (argument === '-u' || argument === '--url') {
      origin = parseOrigin(valueAfter(optionArgs, index, argument))
      index += 1
    } else if (argument === '--host-header') {
      hostHeader = parseHostHeader(valueAfter(optionArgs, index, argument))
      index += 1
    } else if (argument === '--no-host-header') {
      noHostHeader = true
    } else if (argument === '-t' || argument === '--timeout') {
      timeoutMs = parseTimeout(valueAfter(optionArgs, index, argument))
      index += 1
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`)
    } else if (positionalPort === undefined) {
      positionalPort = parsePort(argument)
    } else {
      throw new Error(`Unexpected argument: ${argument}`)
    }
  }

  if (port !== undefined && positionalPort !== undefined) {
    throw new Error('Provide the port either positionally or with --port, not both.')
  }
  port ??= positionalPort
  if (origin && port !== undefined) throw new Error('Use either a port or --url, not both.')
  if (!origin && port === undefined) throw new Error('Provide a local port or --url. Run port2qr --help for examples.')
  if (hostHeader && noHostHeader) throw new Error('Use either --host-header or --no-host-header, not both.')

  origin ??= new URL(`http://127.0.0.1:${port}`)
  if (!noHostHeader) hostHeader ??= origin.host

  return {
    action: 'run',
    command,
    hostHeader: noHostHeader ? null : hostHeader,
    origin,
    timeoutMs,
  }
}
