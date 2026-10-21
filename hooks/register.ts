import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'factory',
      description: 'Software factory: multi-agent build pipeline',
    })
    return next(e)
  })

  on('command.run', { command: 'factory' }, async () => {
    return { text: 'software-factory loaded' }
  })
}
