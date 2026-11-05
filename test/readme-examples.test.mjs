import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {HELP, parseArgs} from '../src/options.mjs'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

// Returns the arguments of every `port2qr ...` command in the README's bash blocks, with an
// optional leading VAR=value environment assignment removed.
function readmeExamples() {
  const examples = []
  for (const [, block] of readme.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block.split('\n')) {
      const command = line.replace(/^(?:[A-Z_]+=\S+\s+)+/, '').trim()
      if (command.startsWith('port2qr ')) examples.push(command.split(/\s+/).slice(1))
    }
  }
  return examples
}

function helpExamples() {
  const section = HELP.slice(HELP.indexOf('Examples:'), HELP.indexOf('Options:'))
  return section.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('port2qr '))
    .map(line => line.split(/\s+/).slice(1))
}

test('every README and help example is a valid command line', () => {
  const examples = [...readmeExamples(), ...helpExamples()]
  assert.ok(examples.length >= 10, 'the README should show the documented CLI forms')
  for (const args of examples) {
    assert.doesNotThrow(() => parseArgs(args), `port2qr ${args.join(' ')}`)
  }
})

test('the README shows every supported CLI form', () => {
  const runs = readmeExamples().map(args => ({args, options: parseArgs(args)}))
  const shows = (description, predicate) => {
    assert.ok(runs.some(predicate), `the README should show ${description}`)
  }

  shows('a positional port', ({args}) => /^\d+$/.test(args[0]))
  shows('--port', ({args}) => args.includes('--port'))
  shows('a port with an owned command', ({args, options}) => /^\d+$/.test(args[0]) && options.command?.length)
  shows('--url', ({args}) => args.includes('--url'))
  shows('--url with an owned command', ({args, options}) => args.includes('--url') && options.command?.length)
  shows('an HTTPS origin', ({options}) => options.origin?.protocol === 'https:')
  shows('--host-header', ({args}) => args.includes('--host-header'))
  shows('--no-host-header', ({options}) => options.hostHeader === null)
  shows('--timeout', ({args}) => args.includes('--timeout'))
  shows('--version', ({options}) => options.action === 'version')
})
