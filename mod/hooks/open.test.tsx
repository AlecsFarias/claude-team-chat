import { expect, mock, test } from 'claude-code/testing'

// Every host command fails, so the gh check ends without touching anything.
test('a new session opens the chat pane without /chat', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const opened: string[] = []
  on('process.run', async () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', async () => ({ value: { command: 'chat' } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: false, reason: 'no-surface' } }
  })

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

  expect(opened).toEqual(['team-chat'])
})
