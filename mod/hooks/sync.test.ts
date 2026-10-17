import { expect, test } from 'claude-code/testing'

import type { ChatMessage, Conversation, SyncState } from '../types'
import { FakeGitHub } from '../tests/fake-github'
import { createChat, postMessage } from './chats'
import type { Run } from './github'
import { createGroup, markRead, openDm, sendMessage, startSync, stopSync, tick } from './sync'
import type { Host, Slot } from './sync'

const GH = 'gh'

function slot<T>(initial: T): Slot<T> & { value: T } {
  const s = {
    value: initial,
    get: async () => s.value,
    set: async (f: (v: T) => T) => void (s.value = f(s.value)),
  }
  return s
}

// Lets pending promise chains run (each GitHub call is a few awaits deep).
const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

// The engine as the sync sees it, in memory: atoms, store, a clock moved by hand,
// and process.run answered by the fake GitHub acting as `hub.as`.
function host() {
  stopSync()
  const hub = new FakeGitHub()
  const stored = new Map<string, unknown>()
  let now = Date.UTC(2026, 9, 17, 12)
  let timers: { at: number; ms: number; fn: () => void; live: boolean }[] = []
  const direct: Run = async (argv, init) => hub.run(argv, init?.stdin)
  const open = slot('')
  const h = {
    run: async (argv, init) => {
      if (h.gate && argv.includes('POST')) await h.gate
      return hub.run(argv, init?.stdin)
    },
    store: {
      get: async key => stored.get(key),
      set: async (key, value) => void stored.set(key, JSON.parse(JSON.stringify(value))),
    },
    conversations: slot<Conversation[]>([]),
    messages: slot<ChatMessage[]>([]),
    unread: slot<Record<string, number>>({}),
    conversationId: open,
    sync: slot<SyncState>({ status: 'idle' }),
    every: (ms, fn) => {
      const t = { at: now + ms, ms, fn, live: true }
      timers.push(t)
      return { cancel: () => void (t.live = false) }
    },
    now: () => now,
  } satisfies Host & { gate?: Promise<void> } as Host & { gate?: Promise<void> }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      timers = timers.filter(t => t.live)
      const next = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at
      next.at += next.ms
      next.fn()
      await flush()
    }
    now = end
    await flush()
  }
  return { h, hub, direct, advance, flush, open }
}

test('discovers chats from invitations, pulls messages and counts unread', async () => {
  const { h, open, hub, direct } = host()
  await createChat(direct, GH, { kind: 'dm', me: 'alice', with: 'bob' })
  await createChat(direct, GH, { kind: 'group', name: 'Squad', me: 'alice' })
  await postMessage(direct, GH, 'alice/tc-dm-alice-bob', 'Oi Bob')
  await postMessage(direct, GH, 'alice/tc-dm-alice-bob', 'Tá aí?')

  hub.as = 'bob'
  const bob = { gh: GH, me: 'bob' }
  await tick(h, bob, true)

  // Only the DM: bob was never invited to the group.
  expect(await h.conversations.get()).toEqual([
    { id: 'alice/tc-dm-alice-bob', name: 'bob', kind: 'dm', memberIds: ['alice', 'bob'], owner: 'alice' },
  ])
  expect((await h.messages.get()).map(m => m.text)).toEqual(['Oi Bob', 'Tá aí?'])
  expect(await h.unread.get()).toEqual({ 'alice/tc-dm-alice-bob': 2 })
  expect(await h.sync.get()).toEqual({ status: 'idle', at: expect.any(Number) })

  // Opening it marks everything read and remembers where across sessions.
  open.value = 'alice/tc-dm-alice-bob'
  await markRead(h, 'alice/tc-dm-alice-bob')
  expect(await h.unread.get()).toEqual({ 'alice/tc-dm-alice-bob': 0 })
  const lastId = (await h.messages.get()).pop()!.id
  expect(await h.store.get('lastRead')).toEqual({ 'alice/tc-dm-alice-bob': lastId })
})

test('polls the open chat every 20 s and the others every 5 min', async () => {
  const { h, open, hub, advance, flush, direct } = host()
  await createChat(direct, GH, { kind: 'group', name: 'Aberto', me: 'alice' })
  await createChat(direct, GH, { kind: 'group', name: 'Outro', me: 'alice' })
  const alice = { gh: GH, me: 'alice' }
  open.value = 'alice/tc-aberto'
  hub.calls = []

  startSync(h, alice)
  await flush()
  const reads = (id: string) => hub.calls.filter(c => c.method === 'GET' && c.path.startsWith(`repos/${id}/issues/1/comments`)).length
  expect([reads('alice/tc-aberto'), reads('alice/tc-outro')]).toEqual([1, 1])

  await advance(20_000)
  await advance(20_000)
  expect([reads('alice/tc-aberto'), reads('alice/tc-outro')]).toEqual([3, 1])

  // A message from someone else in the other chat shows as unread once its turn comes.
  hub.as = 'bob'
  hub.repos.get('alice/tc-outro')!.collaborators.add('bob')
  await postMessage(direct, GH, 'alice/tc-outro', 'novidade')
  hub.as = 'alice'
  await advance(5 * 60_000)
  expect(reads('alice/tc-outro')).toBe(2)
  expect(await h.unread.get()).toEqual({ 'alice/tc-aberto': 0, 'alice/tc-outro': 1 })

  // Unchanged chats answer 304 with the etag.
  const last = hub.calls.filter(c => c.path.startsWith('repos/alice/tc-aberto/issues/1/comments')).pop()!
  expect(last.headers[0]).toMatch(/^If-None-Match: /)
  stopSync()
})

test('sending shows the message at once and gives it back on failure', async () => {
  const { h, open, hub, flush, direct } = host()
  await createChat(direct, GH, { kind: 'group', name: 'Squad', me: 'alice' })
  const alice = { gh: GH, me: 'alice' }
  await tick(h, alice, true)
  open.value = 'alice/tc-squad'

  // Posting waits until released, so the pending message can be seen.
  let release!: () => void
  h.gate = new Promise<void>(r => (release = r))
  const sending = sendMessage(h, alice, 'alice/tc-squad', '  Bom dia  ')
  await flush()
  expect((await h.messages.get()).map(m => [m.text, m.pending])).toEqual([['Bom dia', true]])
  release()
  const sent = await sending
  h.gate = undefined
  expect(sent && 'pending' in sent ? sent.pending : undefined).toBe(undefined)
  expect((await h.messages.get()).map(m => [m.text, m.pending, m.authorId])).toEqual([['Bom dia', undefined, 'alice']])
  expect(hub.repos.get('alice/tc-squad')!.comments.length).toBe(1)

  hub.failing = { 'issues/1/comments': 500 }
  expect(await sendMessage(h, alice, 'alice/tc-squad', 'vai falhar')).toEqual({
    kind: 'unknown',
    message: 'O GitHub está com problemas (HTTP 500). Tente de novo.',
  })
  expect((await h.messages.get()).map(m => m.text)).toEqual(['Bom dia'])
  expect(await h.sync.get()).toEqual({
    status: 'error',
    message: 'O GitHub está com problemas (HTTP 500). Tente de novo.',
    at: expect.any(Number),
  })
})

test('creating a group and opening DMs', async () => {
  const { h, open, hub, direct } = host()
  const alice = { gh: GH, me: 'alice' }

  const group = await createGroup(h, alice, 'Time de Produto')
  expect(group && 'id' in group ? group.id : group).toBe('alice/tc-time-de-produto')
  expect((await h.conversations.get()).map(c => c.id)).toEqual(['alice/tc-time-de-produto'])

  // No DM yet: one is created and bob invited.
  const dm = await openDm(h, alice, 'bob')
  expect(dm && 'id' in dm ? dm.id : dm).toBe('alice/tc-dm-alice-bob')
  expect(hub.invitations.map(i => [i.to, i.repo])).toEqual([['bob', 'alice/tc-dm-alice-bob']])
  // Asking again finds it, without writing.
  const writes = hub.calls.filter(c => c.method !== 'GET').length
  expect(await openDm(h, alice, 'Bob')).toEqual(dm)
  expect(hub.calls.filter(c => c.method !== 'GET').length).toBe(writes)

  // Carol already invited alice to their DM: alice joins it instead of making another.
  hub.as = 'carol'
  await createChat(direct, GH, { kind: 'dm', me: 'carol', with: 'alice' })
  hub.as = 'alice'
  const withCarol = await openDm(h, alice, 'carol')
  expect(withCarol && 'id' in withCarol ? withCarol.id : withCarol).toBe('carol/tc-dm-alice-carol')
  expect(hub.repos.has('alice/tc-dm-alice-carol')).toBe(false)
})
