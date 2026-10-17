import { expect, test } from 'claude-code/testing'

import { FakeGitHub } from '../tests/fake-github'
import {
  acceptInvites,
  addMember,
  base64Utf8,
  createChat,
  dmPeer,
  dmRepoName,
  fetchMessages,
  formatBody,
  groupRepoName,
  isRepoId,
  leaveChat,
  listChats,
  listMembers,
  loadChat,
  mergeMessages,
  parseBody,
  postMessage,
  readMeta,
  unreadCount,
} from './chats'
import type { Run } from './github'

const GH = '/opt/homebrew/bin/gh'

function setup() {
  const hub = new FakeGitHub()
  const run: Run = async (argv, init) => hub.run(argv, init?.stdin)
  return { hub, run }
}

test('repo names and ids', async () => {
  expect(groupRepoName('Time de Produto!')).toBe('tc-time-de-produto')
  expect(groupRepoName('Ação & Reação')).toBe('tc-acao-reacao')
  expect(groupRepoName('!!!')).toBe('tc-grupo')
  expect(groupRepoName('x'.repeat(200)).length).toBe(63)
  expect(dmRepoName('Bob', 'alice')).toBe('tc-dm-alice-bob')
  expect(dmRepoName('alice', 'bob')).toBe(dmRepoName('bob', 'alice'))
  expect(isRepoId('alice/tc-dm-alice-bob')).toBe(true)
  expect(isRepoId('alice/../etc')).toBe(false)
  expect(isRepoId('alice/..')).toBe(false)
  expect(isRepoId('alice')).toBe(false)
  expect(isRepoId('-bad/tc-x')).toBe(false)
  expect(isRepoId('alice/tc x')).toBe(false)
  expect(dmPeer({ id: 'a/b', name: '', kind: 'dm', memberIds: ['Alice', 'bob'] }, 'alice')).toBe('bob')
})

test('message bodies carry text and a marker', async () => {
  const body = formatBody('  Oi time  ', { kind: 'text', viaClaude: true })
  expect(body).toBe('Oi time\n\n<!-- team-chat:v1 {"kind":"text","viaClaude":true} -->')
  expect(parseBody(body)).toEqual({ text: 'Oi time', data: { kind: 'text', viaClaude: true } })

  // A value with "-->" cannot close the HTML comment early.
  const tricky = formatBody('veja', {
    kind: 'context',
    title: 'a --> b <script>',
    summary: 's',
    source: 'summary',
    files: [],
  })
  expect(tricky.includes('a -->')).toBe(false)
  expect(parseBody(tricky).data).toEqual({
    kind: 'context',
    title: 'a --> b <script>',
    summary: 's',
    source: 'summary',
    files: [],
  })

  // Written on github.com: plain text.
  expect(parseBody('direto do site\n')).toEqual({ text: 'direto do site', data: { kind: 'text' } })
  // A broken marker shows the whole body.
  expect(parseBody('oi\n\n<!-- team-chat:v1 {nope} -->').text).toBe('oi\n\n<!-- team-chat:v1 {nope} -->')
})

test('base64 of UTF-8 text', async () => {
  expect(base64Utf8('hello')).toBe('aGVsbG8=')
  expect(base64Utf8('Olá')).toBe('T2zDoQ==')
  expect(base64Utf8('ab')).toBe('YWI=')
  expect(base64Utf8('abc')).toBe('YWJj')
  expect(base64Utf8('👋')).toBe('8J+Riw==')
  expect(base64Utf8('')).toBe('')
})

test('creating a group makes a private repo with topic, meta, issue #1 and muted', async () => {
  const { hub, run } = setup()
  const chat = await createChat(run, GH, { kind: 'group', name: 'Time de Produto', me: 'alice' })
  expect(chat).toEqual({
    id: 'alice/tc-time-de-produto',
    name: 'Time de Produto',
    kind: 'group',
    memberIds: ['alice'],
    owner: 'alice',
  })
  expect(hub.calls.map(c => `${c.method} ${c.path}`)).toEqual([
    'POST user/repos',
    'PUT repos/alice/tc-time-de-produto/topics',
    'PUT repos/alice/tc-time-de-produto/contents/.team-chat/meta.json',
    'POST repos/alice/tc-time-de-produto/labels',
    'POST repos/alice/tc-time-de-produto/issues',
    'PUT repos/alice/tc-time-de-produto/subscription',
  ])
  expect(hub.calls[0]!.body).toEqual({
    name: 'tc-time-de-produto',
    description: 'Claude Team Chat',
    private: true,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  })
  const repo = hub.repos.get('alice/tc-time-de-produto')!
  expect(repo.topics).toEqual(['claude-team-chat'])
  expect(JSON.parse(repo.files['.team-chat/meta.json']!)).toEqual({
    v: 1,
    kind: 'group',
    name: 'Time de Produto',
    createdBy: 'alice',
  })
  expect(repo.issues).toBe(1)
  expect(repo.ignored.has('alice')).toBe(true)
  expect(await readMeta(run, GH, chat && 'id' in chat ? chat.id : '')).toEqual({
    v: 1,
    kind: 'group',
    name: 'Time de Produto',
    createdBy: 'alice',
  })

  // Same name again: "-2".
  const again = await createChat(run, GH, { kind: 'group', name: 'time de produto', me: 'alice' })
  expect(again && 'id' in again ? again.id : again).toBe('alice/tc-time-de-produto-2')

  expect(await createChat(run, GH, { kind: 'group', name: '   ', me: 'alice' })).toEqual({
    kind: 'unknown',
    message: 'Dê um nome ao grupo.',
  })
})

test('a DM: invite, auto-accept, list, read and post', async () => {
  const { hub, run } = setup()
  hub.addRepo('bob/dotfiles')
  const dm = await createChat(run, GH, { kind: 'dm', me: 'alice', with: 'bob' })
  expect(dm).toEqual({ id: 'alice/tc-dm-alice-bob', name: 'bob', kind: 'dm', memberIds: ['alice', 'bob'], owner: 'alice' })
  expect(hub.invitations.map(i => i.to)).toEqual(['bob'])

  // Creating it twice comes back as "exists".
  expect(await createChat(run, GH, { kind: 'dm', me: 'alice', with: 'Bob' })).toEqual({
    kind: 'exists',
    id: 'alice/tc-dm-alice-bob',
    message: 'Essa conversa já existe.',
  })

  const sent = await postMessage(run, GH, 'alice/tc-dm-alice-bob', 'Oi Bob, revisa o PR?')
  expect(sent && 'text' in sent ? [sent.text, sent.authorId, sent.data] : sent).toEqual([
    'Oi Bob, revisa o PR?',
    'alice',
    { kind: 'text' },
  ])

  // Bob, before accepting, cannot see it.
  hub.as = 'bob'
  hub.repos.get('bob/dotfiles')!.topics = []
  expect(await listChats(run, GH)).toEqual({ notModified: false, chats: [], etag: expect.any(String) })
  // A repo invitation that is not a chat stays pending.
  hub.addRepo('carol/project', { description: 'Something else' })
  hub.invitations.push({ id: 1, to: 'bob', repo: 'carol/project' })

  expect(await acceptInvites(run, GH)).toEqual([{ id: 'alice/tc-dm-alice-bob', owner: 'alice', name: 'tc-dm-alice-bob' }])
  expect(hub.invitations.map(i => i.repo)).toEqual(['carol/project'])
  expect(hub.repos.get('alice/tc-dm-alice-bob')!.ignored.has('bob')).toBe(true)

  const listed = await listChats(run, GH)
  expect(listed).toEqual({
    notModified: false,
    chats: [{ id: 'alice/tc-dm-alice-bob', owner: 'alice', name: 'tc-dm-alice-bob' }],
    etag: expect.any(String),
  })
  // Unchanged: 304 on the first page with its etag.
  const etag = listed && 'etag' in listed ? listed.etag : undefined
  expect(await listChats(run, GH, etag)).toEqual({ notModified: true, etag: expect.any(String) })
  expect(hub.calls[hub.calls.length - 1]!.headers).toEqual([`If-None-Match: ${etag}`])

  expect(await loadChat(run, GH, { id: 'alice/tc-dm-alice-bob', owner: 'alice', name: 'tc-dm-alice-bob' })).toEqual({
    id: 'alice/tc-dm-alice-bob',
    name: 'bob',
    kind: 'dm',
    memberIds: ['alice', 'bob'],
    owner: 'alice',
  })

  const first = await fetchMessages(run, GH, 'alice/tc-dm-alice-bob')
  if ('message' in first) throw new Error(first.message)
  expect(first.messages.map(m => [m.authorId, m.text])).toEqual([['alice', 'Oi Bob, revisa o PR?']])
  expect(first.cursor).toEqual({ since: '2026-10-17T12:00:00Z' })

  // The `since` filter is inclusive, so the last one comes again; then 304.
  const second = await fetchMessages(run, GH, 'alice/tc-dm-alice-bob', first.cursor)
  if ('message' in second) throw new Error(second.message)
  expect(second.messages.length).toBe(1)
  expect(second.cursor.etag).toEqual(expect.any(String))
  const third = await fetchMessages(run, GH, 'alice/tc-dm-alice-bob', second.cursor)
  expect(third).toEqual({ messages: [], cursor: second.cursor })

  await postMessage(run, GH, 'alice/tc-dm-alice-bob', 'Reviso sim', { kind: 'text', viaClaude: true })
  const fourth = await fetchMessages(run, GH, 'alice/tc-dm-alice-bob', second.cursor)
  if ('message' in fourth) throw new Error(fourth.message)
  expect(fourth.messages.map(m => [m.authorId, m.text, m.data])).toEqual([
    ['alice', 'Oi Bob, revisa o PR?', { kind: 'text' }],
    ['bob', 'Reviso sim', { kind: 'text', viaClaude: true }],
  ])
  expect(fourth.cursor).toEqual({ since: '2026-10-17T12:00:01Z' })
})

test('members, leaving and errors', async () => {
  const { hub, run } = setup()
  const group = await createChat(run, GH, { kind: 'group', name: 'Squad', me: 'alice' })
  if (!group || !('memberIds' in group)) throw new Error('no group')
  expect(await addMember(run, GH, group.id, 'bob')).toBe(true)
  expect(hub.calls[hub.calls.length - 1]).toEqual({
    as: 'alice',
    method: 'PUT',
    path: 'repos/alice/tc-squad/collaborators/bob',
    headers: [],
    body: { permission: 'push' },
  })
  hub.as = 'bob'
  await acceptInvites(run, GH)
  expect(await listMembers(run, GH, group.id)).toEqual(['alice', 'bob'])

  // The owner cannot leave; a member can.
  expect(await leaveChat(run, GH, group, 'alice')).toEqual({
    kind: 'unknown',
    message: 'Você criou este grupo e não pode sair dele.',
  })
  expect(await leaveChat(run, GH, group, 'bob')).toBe(true)
  expect(await listChats(run, GH)).toEqual({ notModified: false, chats: [], etag: expect.any(String) })

  // Gone or never shared: not found. A bad id never reaches gh.
  expect(await fetchMessages(run, GH, group.id)).toEqual({ kind: 'not-found', message: 'Não encontrado no GitHub.' })
  const before = hub.calls.length
  expect(await postMessage(run, GH, '../x', 'oi')).toEqual({ kind: 'unknown', message: 'Resposta inesperada do GitHub.' })
  expect(await addMember(run, GH, group.id, 'not a login')).toEqual({
    kind: 'unknown',
    message: 'Resposta inesperada do GitHub.',
  })
  expect(hub.calls.length).toBe(before)

  hub.as = 'alice'
  hub.failing = { 'issues/1/comments': 500 }
  expect(await postMessage(run, GH, group.id, 'oi')).toEqual({
    kind: 'unknown',
    message: 'O GitHub está com problemas (HTTP 500). Tente de novo.',
  })
  // A repo with the topic but no meta.json is not a chat to load.
  hub.failing = {}
  hub.addRepo('alice/tc-broken', { topics: ['claude-team-chat'] })
  expect(await loadChat(run, GH, { id: 'alice/tc-broken', owner: 'alice', name: 'tc-broken' })).toEqual({
    kind: 'not-found',
    message: 'Não encontrado no GitHub.',
  })
})

test('merging and unread counts', async () => {
  const m = (id: string, authorId: string, at: number, extra = {}) => ({
    id,
    conversationId: 'a/tc-x',
    authorId,
    text: id,
    at,
    ...extra,
  })
  const merged = mergeMessages([m('2', 'bob', 20), m('1', 'alice', 10)], [m('2', 'bob', 20, { text: 'edited' }), m('3', 'bob', 30)])
  expect(merged.map(x => [x.id, x.text])).toEqual([
    ['1', '1'],
    ['2', 'edited'],
    ['3', '3'],
  ])
  expect(unreadCount(merged, undefined, 'alice')).toBe(2)
  expect(unreadCount(merged, '2', 'Alice')).toBe(1)
  expect(unreadCount([...merged, m('pending-1', 'bob', 40, { pending: true })], '3', 'alice')).toBe(0)
})
