import process from 'node:process'

// Windows cannot deliver SIGINT or SIGTERM to another process: child.kill() terminates it
// outright. The lifecycle harness preloads this module on Windows and sends the signal
// name over IPC, so the CLI runs the same handlers that Ctrl+C would trigger.
process.on('message', message => {
  if (message?.type === 'signal') process.emit(message.signal, message.signal)
})
// The IPC channel must not keep the CLI alive after it finishes.
process.channel?.unref()
