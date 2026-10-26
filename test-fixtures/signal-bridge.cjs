const process = require('node:process')

// Windows cannot send a console control event to a single process, and child.kill()
// terminates it outright, so on Windows the lifecycle harness preloads this module into the
// CLI and relays signals over IPC. Emitting a relayed signal runs the CLI's own handlers, as a
// Ctrl+C in its console would.
process.on('message', message => {
  if (typeof message?.signal === 'string') process.emit(message.signal, message.signal)
})
process.channel.unref()
