import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Avatar, ChatMessage, ChatUser, Conversation, GhState, Profile, SyncState, View } from '../types'
import { checkGh, fetchAvatar, getUser, homeDir, pngBase64 } from './github'
import type { Run } from './github'
import { createGroup, markRead, openDm, sendMessage, startSync } from './sync'
import { dmPeer } from './chats'
import type { Host, Who } from './sync'
import { renderApp } from './views'
import type { Actions } from './views'

const PANE = 'team-chat'
const TITLE = 'Chat'
// $.store key: the GitHub login that pressed "Começar" on this machine.
const SIGNED_IN = 'signedInAs'
// Stands for the signed-in login in stored chats; swapped for it before drawing.
const ME = 'me'

const view = atom({ plugin: 'team-chat', key: 'view' } as const, 'setup' as View)
const gh = atom({ plugin: 'team-chat', key: 'gh' } as const, { status: 'checking' } as GhState)
const conversationId = atom({ plugin: 'team-chat', key: 'conversationId' } as const, '', { shape: 'v2' })
const profile = atom({ plugin: 'team-chat', key: 'profile' } as const, null as Profile | null, { shape: 'v2' })
const contacts = atom({ plugin: 'team-chat', key: 'contacts' } as const, [] as ChatUser[], { shape: 'v3' })
// v3/v4: chats are GitHub repos now (id "owner/tc-..."); local-only chats are dropped.
const conversations = atom({ plugin: 'team-chat', key: 'conversations' } as const, [] as Conversation[], { shape: 'v3' })
const messages = atom({ plugin: 'team-chat', key: 'messages' } as const, [] as ChatMessage[], { shape: 'v4' })
const unread = atom({ plugin: 'team-chat', key: 'unread' } as const, {} as Record<string, number>, { shape: 'v2' })
const avatars = atom({ plugin: 'team-chat', key: 'avatars' } as const, {} as Record<string, Avatar>, { shape: 'v2' })
const draft = atom({ plugin: 'team-chat', key: 'draft' } as const, '')
const groupDraft = atom({ plugin: 'team-chat', key: 'groupDraft' } as const, '')
const contactDraft = atom({ plugin: 'team-chat', key: 'contactDraft' } as const, '')
const groupSearch = atom({ plugin: 'team-chat', key: 'groupSearch' } as const, '')
const contactSearch = atom({ plugin: 'team-chat', key: 'contactSearch' } as const, '')
const contactError = atom({ plugin: 'team-chat', key: 'contactError' } as const, '')
const sync = atom({ plugin: 'team-chat', key: 'sync' } as const, { status: 'idle' } as SyncState)
const busy = atom({ plugin: 'team-chat', key: 'busy' } as const, {} as Record<string, string>)
const frame = atom({ plugin: 'team-chat', key: 'frame' } as const, 0)

// The sample chats name the signed-in person `ME`; draw them as that login.
const asMe = (login: string) => (id: string) => (id === ME ? login : id)

// The terminal spinner: one timer while anything loads (an action, the sync,
// the gh check), stopped when all is quiet. The desktop's spinner animates itself.
let spinner: Timer | undefined

async function spin($: EngineInterface) {
  const loading =
    Object.keys(await read($, busy)).length > 0 ||
    (await read($, sync)).status === 'syncing' ||
    (await read($, gh)).status === 'checking'
  if (!loading) {
    spinner?.cancel()
    spinner = undefined
    return
  }
  await update($, frame, n => (n + 1) % 1000)
}

function startSpinner($: EngineInterface) {
  spinner ??= $.clock.every(120, () => void spin($))
}

// Runs one action with a loading line on screen under `key`.
async function withBusy<T>($: EngineInterface, key: string, label: string, work: () => Promise<T>): Promise<T> {
  await update($, busy, b => ({ ...b, [key]: label }))
  startSpinner($)
  try {
    return await work()
  } finally {
    await update($, busy, b => {
      const { [key]: _, ...rest } = b
      return rest
    })
  }
}

// Module state: a reload checks gh again.
let checking: Promise<void> | undefined
let started = false

async function loadAvatars($: EngineInterface, home: string, people: { id: string; avatarUrl?: string }[]) {
  if (!home) return
  const run: Run = (argv, init) => $.process.run(argv, init)
  const have = await read($, avatars)
  for (const p of people) {
    if (!p.avatarUrl || have[p.id]) continue
    const file = await fetchAvatar(run, p.avatarUrl, p.id, `${home}/.cache/claude-team-chat/avatars`)
    if (!file) continue
    const png = await pngBase64(run, file)
    await update($, avatars, a => ({ ...a, [p.id]: png ? { file, png } : { file } }))
  }
}

// Reads gh and the GitHub profile; never leaves the screen on "checking".
function check($: EngineInterface) {
  checking ??= (async () => {
    const run: Run = (argv, init) => $.process.run(argv, init)
    try {
      await update($, gh, () => ({ status: 'checking' }) as GhState)
      const home = await homeDir(run)
      const state = await checkGh(run, home)
      await update($, gh, () => state)
      if (state.status !== 'ok') {
        await update($, view, () => 'setup' as View)
        return
      }
      const signedIn = await $.store.get(SIGNED_IN)
      if (signedIn === state.profile.id) {
        await update($, profile, () => state.profile)
        if ((await read($, view)) === 'setup') await update($, view, () => 'chat' as View)
        beginSync($, state)
      } else {
        await update($, view, () => 'setup' as View)
      }
      await loadAvatars($, home, [state.profile, ...(await read($, contacts))])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await update($, gh, () => ({ status: 'error', message: `Falha ao verificar o gh: ${message}` }) as GhState).catch(() => {})
    }
  })().finally(() => {
    checking = undefined
  })
  return checking
}

// The engine as hooks/sync.ts uses it; the atoms stay here, where the scan reads them.
function hostOf($: EngineInterface): Host {
  return {
    run: (argv, init) => $.process.run(argv, init),
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    every: (ms, fn) => $.clock.every(ms, fn),
    now: () => Date.now(),
    conversations: { get: () => read($, conversations), set: async f => void (await update($, conversations, f)) },
    messages: { get: () => read($, messages), set: async f => void (await update($, messages, f)) },
    unread: { get: () => read($, unread), set: async f => void (await update($, unread, f)) },
    conversationId: { get: () => read($, conversationId) },
    sync: { get: () => read($, sync), set: async f => void (await update($, sync, f)) },
  }
}

// Starts polling GitHub once the person is signed in (hooks/sync.ts).
function beginSync($: EngineInterface, state: GhState) {
  if (state.status === 'ok') startSync(hostOf($), { gh: state.gh, me: state.profile.id })
}

// The signed-in person as the sync calls GitHub, or null before "Começar".
async function who($: EngineInterface): Promise<Who | null> {
  const state = await read($, gh)
  const me = await read($, profile)
  return state.status === 'ok' && me ? { gh: state.gh, me: me.id } : null
}

// Work that outlives a dispatch runs on a timer; state can't be written while drawing.
function startCheck($: EngineInterface) {
  if (started) return
  started = true
  $.clock.after(0, () => void check($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'chat', description: 'Abrir a aba de chat' })
    startCheck($)
    // Open the chat beside the transcript in every session, so nobody has to
    // type /chat; it waits undrawn until a surface that docks it attaches.
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  // A surface that joins later (the desktop app) gets the chat too; when it
  // doesn't place an unasked pane, say why instead of failing quietly.
  on('session.attach', async ($, e, next) => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (!opened.isPlaced) {
      // The engine places an unasked pane only on a wide enough surface (144
      // columns, 110 once the person opened it); say how to open it instead.
      $.ui.log(`Chat: não abriu sozinho (${opened.reason}).`)
      $.ui.toast('Chat pronto. Digite /chat para abrir.', { timeoutMs: 8000 })
    }

    return next(e)
  })

  on('command.run', { command: 'chat' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Chat aberto.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const run: Run = (argv, init) => $.process.run(argv, init)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Link = 'Link' in els ? els.Link : undefined
    // Pictures: the terminal reads a PNG file; desktop and mobile draw an Svg.
    const Image = e.surface === 'terminal' && 'Image' in els ? els.Image : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined

    const ghState = await read($, gh)
    startCheck($)
    // The terminal's spinner turns only while something loads.
    if (e.surface === 'terminal' && (ghState.status === 'checking' || (await read($, sync)).status === 'syncing')) {
      startSpinner($)
    }

    const me = await read($, profile)
    const login = me?.id ?? ME
    const mine = asMe(login)
    const currentView = me ? await read($, view) : 'setup'
    const currentId = await read($, conversationId)
    // A DM is named after the other person, as each side knows them.
    const people = await read($, contacts)
    const dmName = (c: Conversation) => {
      const peer = dmPeer(c, login)
      return people.find(p => p.id.toLowerCase() === peer?.toLowerCase())?.name ?? peer ?? c.name
    }
    const allConversations = (await read($, conversations)).map(c => ({
      ...c,
      name: c.kind === 'dm' ? dmName(c) : c.name,
      memberIds: c.memberIds.map(mine),
    }))
    const allMessages = (await read($, messages)).map(m => ({ ...m, authorId: mine(m.authorId) }))
    const current = allConversations.find(c => c.id === currentId) ?? allConversations[0]

    const open = async (id: string) => {
      await update($, conversationId, () => id)
      await update($, unread, u => ({ ...u, [id]: 0 }))
      await update($, view, () => 'chat' as View)
      await markRead(hostOf($), id)
    }

    const act: Actions = {
      go: next => void update($, view, () => next),
      open: id => void open(id),
      openDm: async userId => {
        const w = await who($)
        if (!w) return
        const dm = await withBusy($, 'dm', 'Abrindo a conversa no GitHub…', () => openDm(hostOf($), w, userId))
        if ('message' in dm) return void $.ui.toast(dm.message)
        await open(dm.id)
      },
      send: async value => {
        const text = value.trim()
        const w = await who($)
        if (!text || !current || !w) return
        await update($, draft, () => '')
        const sent = await sendMessage(hostOf($), w, current.id, text)
        if ('message' in sent && !('conversationId' in sent)) {
          // Give the text back so nothing typed is lost.
          await update($, draft, d => d || text)
          $.ui.toast(`Não enviou: ${sent.message}`)
        }
      },
      setDraft: value => void update($, draft, () => value),
      createGroup: async value => {
        const name = value.trim().replace(/^#\s*/, '')
        const w = await who($)
        if (!name || !w) return
        const group = await withBusy($, 'group', `Criando # ${name} no GitHub…`, () => createGroup(hostOf($), w, name))
        if ('message' in group) return void $.ui.toast(`Não criou o grupo: ${group.message}`)
        await update($, groupDraft, () => '')
        await open(group.id)
      },
      setGroupDraft: value => void update($, groupDraft, () => value),
      setGroupSearch: value => void update($, groupSearch, () => value),
      setContactSearch: value => void update($, contactSearch, () => value),
      addContact: async value => {
        const handle = value.trim().replace(/^@/, '')
        if (!handle) return
        const state = await read($, gh)
        if (state.status !== 'ok') return
        const known = await read($, contacts)
        if (handle.toLowerCase() === state.profile.id.toLowerCase()) {
          await update($, contactError, () => 'Esse é você.')
          return
        }
        if (known.some(p => p.id.toLowerCase() === handle.toLowerCase())) {
          await update($, contactError, () => `@${handle} já está nos contatos.`)
          return
        }
        const found = await withBusy($, 'contact', `Procurando @${handle} no GitHub…`, () => getUser(run, state.gh, handle))
        if ('kind' in found) {
          await update($, contactError, () => found.message)
          return
        }
        await update($, contacts, l => [...l, found as ChatUser])
        await update($, contactDraft, () => '')
        await update($, contactError, () => '')
        await loadAvatars($, await homeDir(run), [found])
      },
      setContactDraft: value => {
        void update($, contactDraft, () => value)
        void update($, contactError, () => '')
      },
      retryGh: () => void check($),
      start: async () => {
        const state = await read($, gh)
        if (state.status !== 'ok') return
        await $.store.set(SIGNED_IN, state.profile.id)
        await update($, profile, () => state.profile)
        await update($, view, () => 'chat' as View)
        beginSync($, state)
      },
    }

    return renderApp({
      ui: { Box, Text, Button, Input, Link, Image, Svg },
      cols: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      now: Date.now(),
      view: currentView,
      gh: ghState,
      profile: me,
      contacts: await read($, contacts),
      conversations: allConversations,
      current,
      messages: current ? allMessages.filter(m => m.conversationId === current.id) : [],
      lastMessages: Object.fromEntries(allMessages.map(m => [m.conversationId, m])),
      unread: await read($, unread),
      avatars: await read($, avatars),
      draft: await read($, draft),
      groupDraft: await read($, groupDraft),
      contactDraft: await read($, contactDraft),
      groupSearch: await read($, groupSearch),
      contactSearch: await read($, contactSearch),
      contactError: await read($, contactError),
      busy: await read($, busy),
      frame: await read($, frame),
      sync: await read($, sync),
      act,
    })
  })
}
