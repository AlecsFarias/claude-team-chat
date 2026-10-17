import { expect, mock, test } from 'claude-code/testing'
import type { ElementQuery, FoundElement, MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { FakeGitHub } from '../tests/fake-github'

// The chat after "Entrar com GitHub": chat, members, groups, contacts and the
// profile. A fake host answers every command (see setup.test.tsx for the setup
// states); nothing reaches a real gh, curl or GitHub.

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
  ghAt?: string | null
  loggedIn?: boolean
  scopes?: string[]
  user?: FakeUser
  users?: Record<string, FakeUser | 404>
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

// Answers `$.process.run` as a Mac with gh signed in as octocat. Anything not
// listed (curl, mkdir, sips, ...) fails, so avatars are drawn as initials.
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
  // Chats, messages and members: an in-memory GitHub acting as the signed-in user.
  const hub = new FakeGitHub()
  hub.as = opts.user?.login ?? 'octocat'

  const api = (argv: readonly string[], stdin?: string) => {
    const include = argv.includes('-i') || argv.includes('--include')
    const path = (argv[argv.length - 1] ?? '').replace(/^\//, '')
    if (path !== 'user' && !path.startsWith('users/')) return hub.run(argv, stdin)
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

  const answer = async (argv: readonly string[], stdin?: string): Promise<ProcessRunResult> => {
    calls.push([...argv])
    const [bin = '', ...args] = argv

    if (/(^|\/)sh$/.test(bin) && args[0] === '-c') {
      return /HOME/.test(args[1] ?? '') ? result(0, HOME) : result(1, '', 'fake host: not faked')
    }

    if (/(^|\/)gh$/.test(bin)) {
      if (!opts.ghAt || bin !== opts.ghAt) return result(127, '', `sh: ${bin}: command not found`)
      if (args[0] === '--version') {
        return result(0, 'gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n')
      }
      if (args[0] === 'auth' && args[1] === 'status') return authStatus()
      if (args[0] === 'api') return api(argv, stdin)
      return result(1, '', 'fake host: gh subcommand not faked')
    }

    return result(1, '', `fake host: ${bin} not faked`)
  }

  // The test's hook stands for the engine: what it answers is what the mod gets.
  on('process.run', async (_$, e) => ({ value: await answer(e.argv, e.init?.stdin) }))

  return { opts, calls, hub }
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
    noPresence: async () => {
      await clock.settle()
      const leaves = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
      const hit = leaves.find(el => PEOPLE.test(el.text) && PRESENCE.test(el.text))
      if (hit) throw new Error(`${surface}: presence word next to a person: ${hit.text}`)
    },
    lacks: async (text: RegExp) => {
      await clock.settle()
      const hit = (await shown(ui)).find(s => text.test(s))
      if (hit !== undefined) throw new Error(`${surface}: ${text} should not be drawn, found in: ${hit}`)
    },
    button: async (key: string) => {
      let found: FoundElement | undefined
      for (let i = 0; i < 100 && !found; i++) {
        found = await ui.find({ type: 'Button', key })
        if (!found) await clock.settle()
      }
      if (!found) throw new Error(`${surface}: no Button "${key}" drawn in: ${(await shown(ui)).join(' | ')}`)
      return found
    },
  }
}

// Presence words from the prototype next to a person; only "ativo há …" remains.
// (The composer may still say the chat itself is offline in phase 2.)
const PEOPLE = /Ana Souza|Bruno Lima|Carla Mendes|Diego Rocha|Hubot/
const PRESENCE = /\b(online|offline)\b/i

// A Box's width and height are cells on every surface: an avatar sized in
// pixels on a Box once took most of the desktop pane.
async function noOversizedBox(ui: Drawing, surface: string) {
  const wide = (await ui.findAll({ type: 'Box' })).filter(
    b =>
      (typeof b.props.width === 'number' && b.props.width > 12) ||
      (typeof b.props.height === 'number' && b.props.height > 6 && b.props.height < PANE.props.scroll.bodyRows - 6),
  )
  expect(wide.map(b => `${b.props.width}x${b.props.height}`), `${surface}: oversized Box`).toEqual([])
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`chat, members, groups, contacts and profile on ${surface}`, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    fakeHost(on, {
      users: {
        hubot: { login: 'hubot', name: 'Hubot', html_url: 'https://github.com/hubot', type: 'User' },
        ghost404: 404,
      },
    })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, ...PANE })
    const c = checks(ui, clock, surface)

    // Setup first: gh is fine, so "Começar".
    await c.button('setup-start')
    await ui.press({ key: 'setup-start' })

    // App header (the GitHub name), and no sample chats: the empty state.
    await c.has(/Mona Lisa/)
    await c.has(/@octocat · perfil/)
    await c.has(/Nenhuma conversa ainda/)
    await c.lacks(/# geral|Ana Souza|bom dia/)
    // No unread badges with nothing to read.
    expect((await c.button('nav-groups')).text, `${surface}: groups tab`).toBe('Grupos')
    expect((await c.button('nav-contacts')).text, `${surface}: contacts tab`).toBe('Contatos')

    // Avatars: an Svg on the desktop (initials here, curl is not faked), none on the terminal.
    const svg = await ui.find({ type: 'Svg' })
    if (surface === 'desktop') expect(svg, `${surface}: avatar Svg`).toBeDefined()
    else expect(svg, `${surface}: no Svg`).toBeUndefined()

    await noOversizedBox(ui, surface)

    // Groups: empty, then create one and land in it.
    await ui.press({ key: 'empty-groups' })
    await c.has(/Nenhum grupo ainda/)
    await ui.input({ key: 'new-group', text: `time ${surface}` })
    await c.has(new RegExp(`# time ${surface}`))
    await c.has(/GRUPO · 1 MEMBRO\b/)
    await c.has(/Nenhuma mensagem ainda/)

    // Sending appends.
    await ui.input({ key: 'composer', text: `olá de ${surface}` })
    await c.has(new RegExp(`olá de ${surface}`))
    await c.lacks(/Nenhuma mensagem ainda/)

    // Later-phase controls are drawn, in gray, and are not buttons.
    for (const key of ['soon-files', 'soon-attach', 'soon-share', 'soon-task']) {
      expect(await ui.find({ type: 'Box', key }), `${surface}: ${key} drawn`).toBeDefined()
      expect(await ui.find({ type: 'Button', key }), `${surface}: ${key} pressable`).toBeUndefined()
    }
    await c.has(/Compartilhar contexto/)

    // Members of the group: just you; adding and leaving come later.
    await ui.press({ key: 'show-members' })
    await c.has(/Mona Lisa \(você\)/)
    expect(await ui.find({ type: 'Box', key: 'soon-add-member' }), `${surface}: soon-add-member`).toBeDefined()
    expect(await ui.find({ type: 'Box', key: 'soon-leave' }), `${surface}: soon-leave`).toBeDefined()
    await ui.press({ key: 'back' })
    await c.has(new RegExp(`# time ${surface}`))

    // The group list previews the last message.
    await ui.press({ key: 'nav-groups' })
    await c.has(new RegExp(`você: olá de ${surface}`))
    await c.has(/aberto no chat/)
    await c.button('back')
    expect((await c.button('back')).text, `${surface}: back names the open group`).toMatch(new RegExp(`# time ${surface}`))

    // Every group in the list has an explicit way back into it.
    await ui.press({ key: 'nav-contacts' })
    await ui.press({ key: 'nav-groups' })
    const openButtons = (await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key ?? '').startsWith('group-open-'))
    expect(openButtons.length, `${surface}: group open buttons`).toBe(1)
    await ui.press({ key: openButtons[0]!.props.key as string })
    await c.has(new RegExp(`olá de ${surface}`))
    await ui.press({ key: 'nav-groups' })

    // Contacts: empty, then add by GitHub @.
    await ui.press({ key: 'nav-contacts' })
    await c.has(/Nenhum contato ainda/)
    await c.has(/Adicionar pelo @ do GitHub/i)
    expect(await ui.find({ type: 'Input', key: 'new-contact' }), `${surface}: new-contact Input`).toBeDefined()

    // An @ GitHub does not know: an error, nothing added.
    await ui.input({ key: 'new-contact', text: 'ghost404' })
    await c.has(/não existe no GitHub/)
    expect(await ui.find({ type: 'Button', key: 'contact-ghost404' }), `${surface}: ghost404 added`).toBeUndefined()

    // One it knows: added under its GitHub name, field cleared, error gone.
    await ui.input({ key: 'new-contact', text: '@hubot' })
    await c.button('contact-hubot')
    await c.has(/Hubot/)
    await c.lacks(/não existe no GitHub/)
    await c.lacks(/Nenhum contato ainda/)
    expect((await ui.find({ type: 'Input', key: 'new-contact' }))?.text ?? '', `${surface}: field cleared`).toBe('')
    await c.noPresence()

    // Its button opens the direct conversation.
    await ui.press({ key: 'contact-hubot' })
    await c.has(/CONVERSA DIRETA/)
    await c.has(/Mensagem para (@ )?Hubot/)
    await c.has(/Comece a conversa com Hubot/)

    // Profile: read-only, from GitHub.
    await ui.press({ key: 'nav-profile' })
    await c.has(/Mona Lisa/)
    await c.has(/@octocat/)
    await c.has(/Ver no GitHub/)
    // The big avatar is sized in pixels by its Svg, not by a Box in cells.
    await noOversizedBox(ui, surface)
    await c.has(/Nome e foto vêm do seu perfil no GitHub\./)
    expect(await ui.find({ type: 'Input' }), `${surface}: profile has no field`).toBeUndefined()
    await ui.press({ key: 'back' })
    await c.lacks(/Nome e foto vêm do seu perfil no GitHub/)

    await ui.unmount()
  })
}
