import { expect, mock, test } from 'claude-code/testing'
import type { ElementQuery, FoundElement, MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

// The setup screen ("Entrar com GitHub"): gh is checked on first open and each
// state says how to fix it. Every command is answered by a fake host below;
// nothing reaches a real gh, curl or GitHub.

const PANE = {
  component: 'Pane',
  requestId: 'team-chat',
  props: {
    title: 'Chat',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 36 },
    view: {},
  },
  viewport: { columns: 80, rows: 40 },
} as const

const HOME = '/Users/tester'

type FakeUser = { login: string; name?: string | null; avatar_url?: string; html_url?: string; type?: string }

type HostOptions = {
  // Where gh answers `--version`; null: nowhere (not installed).
  ghAt?: string | null
  loggedIn?: boolean
  // `Token scopes:` in `gh auth status`; undefined lists none (fine-grained token).
  scopes?: string[]
  // `gh api user`.
  user?: FakeUser
  // `gh api users/<login>`; 404 or a missing login: no such user.
  users?: Record<string, FakeUser | 404>
  // While set, `gh --version` waits for it, so the "checking" state can be seen.
  hold?: Promise<void>
}

const OCTOCAT: FakeUser = {
  login: 'octocat',
  name: 'Mona Lisa',
  avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
  html_url: 'https://github.com/octocat',
  type: 'User',
}

const result = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// Answers `$.process.run` the way a Mac with (or without) gh would. Options are
// read on every call, so a test can change them and press "Tentar de novo".
// Anything not listed (curl, mkdir, sips, od, ...) fails, so avatars fall back
// to initials and no real process ever starts.
function fakeHost(on: On, initial: HostOptions = {}) {
  const opts: HostOptions = {
    ghAt: 'gh',
    loggedIn: true,
    scopes: ['gist', 'read:org', 'repo', 'workflow'],
    user: OCTOCAT,
    users: {},
    ...initial,
  }
  const calls: string[][] = []

  const api = (argv: readonly string[]) => {
    const include = argv.includes('-i') || argv.includes('--include')
    const path = (argv[argv.length - 1] ?? '').replace(/^\//, '')
    let found: FakeUser | 404 = 404
    if (path === 'user') found = opts.user ?? 404
    else if (path.startsWith('users/')) {
      const login = path.slice('users/'.length).toLowerCase()
      const entry = Object.entries(opts.users ?? {}).find(([k]) => k.toLowerCase() === login)
      found = entry ? entry[1] : 404
    }
    const scopesHeader = `X-Oauth-Scopes: ${(opts.scopes ?? []).join(', ')}`
    if (found === 404) {
      const body = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}'
      const head = `HTTP/2.0 404 Not Found\nContent-Type: application/json; charset=utf-8\n${scopesHeader}\n\n`
      return result(1, include ? head + body : body, 'gh: Not Found (HTTP 404)\n')
    }
    const body = JSON.stringify(found)
    const head = `HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\n${scopesHeader}\n\n`
    return result(0, include ? head + body : body)
  }

  const authStatus = () => {
    if (!opts.loggedIn) {
      return result(1, '', 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n')
    }
    const login = opts.user?.login ?? 'octocat'
    const lines = [
      'github.com',
      `  ✓ Logged in to github.com account ${login} (keyring)`,
      '  - Active account: true',
      '  - Git operations protocol: https',
    ]
    if (opts.scopes) lines.push(`  - Token scopes: ${opts.scopes.map(s => `'${s}'`).join(', ') || 'none'}`)
    const text = `${lines.join('\n')}\n`
    return result(0, text, text)
  }

  const answer = async (argv: readonly string[]): Promise<ProcessRunResult> => {
    calls.push([...argv])
    const [bin = '', ...args] = argv

    // `/bin/sh -c 'printf %s "$HOME"'` and the like.
    if (/(^|\/)sh$/.test(bin) && args[0] === '-c') {
      return /HOME/.test(args[1] ?? '') ? result(0, HOME) : result(1, '', 'fake host: not faked')
    }

    if (/(^|\/)gh$/.test(bin)) {
      if (!opts.ghAt || bin !== opts.ghAt) return result(127, '', `sh: ${bin}: command not found`)
      if (args[0] === '--version') {
        if (opts.hold) await opts.hold
        return result(0, 'gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n')
      }
      if (args[0] === 'auth' && args[1] === 'status') return authStatus()
      if (args[0] === 'api') return api(argv)
      return result(1, '', 'fake host: gh subcommand not faked')
    }

    return result(1, '', `fake host: ${bin} not faked`)
  }

  // The test's hook stands for the engine: what it answers is what the mod gets.
  on('process.run', async (_$, e) => ({ value: await answer(e.argv) }))

  return { opts, calls }
}

type Drawing = {
  find: (query: ElementQuery) => Promise<FoundElement | undefined>
  findAll: (query: ElementQuery) => Promise<FoundElement[]>
}

// Every string the drawing shows or carries: Text, Button labels, Input values
// and placeholders, Link targets.
async function shown(ui: Drawing): Promise<string[]> {
  const all = await ui.findAll({})
  return all.flatMap(el => [el.text, ...Object.values(el.props).filter((v): v is string => typeof v === 'string')])
}

// Checks against what is drawn, letting background work (the gh check) settle
// for a while first, since mounting does not wait for it.
function checks(ui: Drawing, clock: MockClock, surface: string) {
  const until = async (ok: (texts: string[]) => boolean) => {
    let texts: string[] = []
    for (let i = 0; i < 100; i++) {
      texts = await shown(ui)
      if (ok(texts)) return texts
      await clock.settle()
    }
    return texts
  }
  return {
    has: async (text: RegExp) => {
      const texts = await until(t => t.some(s => text.test(s)))
      if (!texts.some(s => text.test(s))) throw new Error(`${surface}: ${text} not drawn in: ${texts.join(' | ')}`)
    },
    lacks: async (text: RegExp) => {
      await clock.settle()
      const texts = await shown(ui)
      const hit = texts.find(s => text.test(s))
      if (hit !== undefined) throw new Error(`${surface}: ${text} should not be drawn, found in: ${hit}`)
    },
    button: async (key: string, label: RegExp) => {
      let found: FoundElement | undefined
      for (let i = 0; i < 100 && !found; i++) {
        found = await ui.find({ type: 'Button', key })
        if (!found) await clock.settle()
      }
      if (!found) throw new Error(`${surface}: no Button "${key}" drawn in: ${(await shown(ui)).join(' | ')}`)
      expect(found.text, `${surface}: label of ${key}`).toMatch(label)
    },
    noButton: async (key: string) => {
      await clock.settle()
      expect(await ui.find({ type: 'Button', key }), `${surface}: Button ${key} should be gone`).toBeUndefined()
    },
  }
}

const ran = (calls: string[][], want: (argv: string[]) => boolean) => calls.some(want)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`first open checks gh, Começar opens the chat, reopening skips setup on ${surface}`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 17, 12) })
    let release: () => void = () => {}
    const hold = new Promise<void>(resolve => {
      release = resolve
    })
    const host = fakeHost(on, { hold })

    let ui = await $.ui.mount({ plugin: 'team-chat', surface, ...PANE })
    let c = checks(ui, clock, surface)

    // While gh has not answered.
    await c.has(/Verificando o gh/)
    // A spinner turns beside it: an animated Svg on the desktop, a braille frame on the terminal.
    if (surface === 'desktop') {
      const spin = (await ui.findAll({ type: 'Svg' })).find(el => el.props.alt === 'carregando')
      expect(spin?.props.isInteractive, `${surface}: animated spinner`).toBe(true)
    } else {
      await c.has(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/)
    }
    host.opts.hold = undefined
    release()

    // gh answered: the GitHub profile and "Começar".
    await c.has(/Mona Lisa/)
    await c.has(/@octocat/)
    await c.button('setup-start', /Começar/)
    await c.noButton('setup-retry')

    // What was run: the version probe, the sign-in on github.com, the user.
    expect(ran(host.calls, a => a[0] === 'gh' && a[1] === '--version'), 'gh --version').toBe(true)
    expect(
      ran(host.calls, a => a[0] === 'gh' && a[1] === 'auth' && a[2] === 'status' && a.includes('github.com')),
      'gh auth status -h github.com',
    ).toBe(true)
    expect(ran(host.calls, a => a[0] === 'gh' && a.includes('api') && a.includes('user')), 'gh api user').toBe(true)
    // The token is never asked for.
    expect(ran(host.calls, a => a.includes('token') || a.includes('--show-token')), 'token read').toBe(false)

    await ui.press({ key: 'setup-start' })
    await c.has(/· perfil/)
    await c.has(/Mona Lisa/)
    await c.has(/Nenhuma conversa ainda/)
    await c.noButton('setup-start')

    // Closing and opening the pane again goes straight to the chat.
    await ui.unmount()
    ui = await $.ui.mount({ plugin: 'team-chat', surface, ...PANE })
    c = checks(ui, clock, surface)
    await c.has(/Nenhuma conversa ainda/)
    await c.noButton('setup-start')
    await c.lacks(/Verificando o gh/)
    await ui.unmount()
  })

  test(`gh not installed, then found after "Tentar de novo" on ${surface}`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const host = fakeHost(on, { ghAt: null })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, ...PANE })
    const c = checks(ui, clock, surface)
    await c.has(/gh não encontrado/)
    await c.button('setup-retry', /Tentar de novo/)
    await c.noButton('setup-start')

    // Every usual place was tried.
    for (const at of ['gh', `${HOME}/.local/bin/gh`, '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
      expect(ran(host.calls, a => a[0] === at && a[1] === '--version'), `${at} --version`).toBe(true)
    }

    // Installed with Homebrew meanwhile.
    host.opts.ghAt = '/opt/homebrew/bin/gh'
    await ui.press({ key: 'setup-retry' })
    await c.has(/Mona Lisa/)
    await c.has(/@octocat/)
    await c.button('setup-start', /Começar/)
    await c.lacks(/gh não encontrado/)
    // The API was called through the gh that was found.
    expect(ran(host.calls, a => a[0] === '/opt/homebrew/bin/gh' && a.includes('api') && a.includes('user')), 'api via found gh').toBe(true)
    await ui.unmount()
  })

  test(`gh outside the PATH, in ~/.local/bin, is found on ${surface}`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const host = fakeHost(on, { ghAt: `${HOME}/.local/bin/gh` })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, ...PANE })
    const c = checks(ui, clock, surface)
    await c.has(/Mona Lisa/)
    await c.button('setup-start', /Começar/)
    expect(
      ran(host.calls, a => a[0] === `${HOME}/.local/bin/gh` && a[1] === 'auth' && a[2] === 'status'),
      'auth status via ~/.local/bin/gh',
    ).toBe(true)
    await ui.unmount()
  })

  test(`gh without login, then logged in after "Tentar de novo" on ${surface}`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const host = fakeHost(on, { loggedIn: false })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, ...PANE })
    const c = checks(ui, clock, surface)
    await c.has(/gh sem login/)
    await c.button('setup-retry', /Tentar de novo/)
    await c.noButton('setup-start')

    host.opts.loggedIn = true
    await ui.press({ key: 'setup-retry' })
    await c.has(/Mona Lisa/)
    await c.button('setup-start', /Começar/)
    await c.lacks(/gh sem login/)
    await ui.unmount()
  })

  test(`token without the repo scope, then fixed after "Tentar de novo" on ${surface}`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const host = fakeHost(on, { scopes: ['gist', 'read:org'] })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, ...PANE })
    const c = checks(ui, clock, surface)
    await c.has(/Falta o escopo repo/)
    await c.button('setup-retry', /Tentar de novo/)
    await c.noButton('setup-start')

    host.opts.scopes = ['gist', 'read:org', 'repo']
    await ui.press({ key: 'setup-retry' })
    await c.has(/Mona Lisa/)
    await c.button('setup-start', /Começar/)
    await c.lacks(/Falta o escopo repo/)
    await ui.unmount()
  })
}
