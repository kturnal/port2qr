import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// npm and npx are batch-file shims on Windows. Node refuses to spawn batch files without a
// shell, so run the JavaScript entry point that the shim would run with the same Node.js
// executable the shim would choose.
const WINDOWS_NODE_SHIMS = new Map([
  ['npm', 'npm-cli.js'],
  ['npx', 'npx-cli.js'],
])

function windowsPathEntries(env) {
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH')
  return (key ? env[key] : '')
    .split(';')
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

function resolveWindowsNodeShim(name, {env, execPath, existsSync}) {
  const script = WINDOWS_NODE_SHIMS.get(name)
  for (const directory of windowsPathEntries(env)) {
    if (!existsSync(path.win32.join(directory, `${name}.cmd`))) continue
    const cli = path.win32.join(directory, 'node_modules', 'npm', 'bin', script)
    if (!existsSync(cli)) continue
    const bundledNode = path.win32.join(directory, 'node.exe')
    return {file: existsSync(bundledNode) ? bundledNode : execPath, prefixArgs: [cli]}
  }
  throw new Error(`${name} was not found on PATH.`)
}

// Returns the executable and arguments to spawn, without a shell, for a user command.
export function resolveCommand(command, {
  env = process.env,
  execPath = process.execPath,
  existsSync = fs.existsSync,
  platform = process.platform,
} = {}) {
  const [program, ...args] = command
  if (platform === 'win32') {
    const name = program.toLowerCase().replace(/\.cmd$/, '')
    if (WINDOWS_NODE_SHIMS.has(name)) {
      const {file, prefixArgs} = resolveWindowsNodeShim(name, {env, execPath, existsSync})
      return {file, args: [...prefixArgs, ...args]}
    }
  }
  return {file: program, args}
}
