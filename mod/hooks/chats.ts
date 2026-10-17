// Chats on GitHub: each chat is a private repo `tc-...` with the topic
// `claude-team-chat`, its messages are the comments of issue #1 and its
// members are the repo's collaborators (see docs/MVP.md, section 4).
// Pure over the injected runner, like github.ts; every call goes through `ghApi`.

import type { ChatMessage, ChatMeta, Conversation, MessageData } from '../types'
import { ghApi, isLogin } from './github'
import type { GhError, Run } from './github'

export const TOPIC = 'claude-team-chat'
export const PREFIX = 'tc-'
export const LABEL = 'team-chat'
// The repo description, also how an invitation is recognised before accepting it
// (an invitee cannot read the private repo's topics yet).
export const DESCRIPTION = 'Claude Team Chat'
export const ISSUE = 1
const META_PATH = '.team-chat/meta.json'
const PER_PAGE = 100
const MAX_PAGES = 10

const unexpected: GhError = { kind: 'unknown', message: 'Resposta inesperada do GitHub.' }

// --- Names -------------------------------------------------------------------

export function groupSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'grupo'
  )
}

export const groupRepoName = (name: string) => `${PREFIX}${groupSlug(name)}`

// One repo per pair, whoever creates it: logins lowercased, in alphabetical order.
export function dmRepoName(a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort()
  return `${PREFIX}dm-${x}-${y}`
}

// "owner/name" with both parts valid GitHub names; anything else never reaches a URL.
export function isRepoId(id: string): boolean {
  const [owner, name, extra] = id.split('/')
  return (
    extra === undefined && !!owner && !!name && isLogin(owner) && /^[A-Za-z0-9._-]{1,100}$/.test(name) && !/^\.+$/.test(name)
  )
}

// The other person in a DM, as the chat header and contacts list show it.
export const dmPeer = (chat: Conversation, me: string) => chat.memberIds.find(id => id.toLowerCase() !== me.toLowerCase())

// --- Message bodies ----------------------------------------------------------

const MARKER = /\n*<!-- team-chat:v1 (\{.*\}) -->\s*$/s

// Readable text on github.com, then the structured data in an HTML comment. `<`
// and `>` are escaped inside the JSON so no value can close the comment early.
export function formatBody(text: string, data: MessageData = { kind: 'text' }): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  return `${text.trim()}\n\n<!-- team-chat:v1 ${json} -->`
}

// A comment without a valid marker (one written on github.com) is plain text.
export function parseBody(body: string): { text: string; data: MessageData } {
  const found = MARKER.exec(body)
  if (found) {
    try {
      const data = JSON.parse(found[1]!) as MessageData
      if (data && typeof data === 'object' && typeof data.kind === 'string') {
        return { text: body.slice(0, found.index).trim(), data }
      }
    } catch {
      // Broken marker: show the whole body.
    }
  }
  return { text: body.trim(), data: { kind: 'text' } }
}

type GitHubComment = {
  id: number
  body?: string | null
  user?: { login?: string } | null
  created_at: string
  updated_at?: string
}

export function toMessage(chatId: string, c: GitHubComment): ChatMessage {
  const { text, data } = parseBody(c.body ?? '')
  return {
    id: String(c.id),
    conversationId: chatId,
    authorId: c.user?.login ?? 'ghost',
    text,
    at: Date.parse(c.created_at),
    data,
  }
}

// --- Base64 (no Buffer or btoa in the mod runtime) ----------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64Utf8(text: string): string {
  const bytes: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) bytes.push(cp)
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[n >> 18]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

// --- Chats -------------------------------------------------------------------

type GitHubRepo = {
  name: string
  full_name: string
  owner: { login: string }
  private?: boolean
  description?: string | null
  topics?: string[]
}

export type ChatRef = { id: string; owner: string; name: string }

const isChatRepo = (r: GitHubRepo) =>
  r.name.toLowerCase().startsWith(PREFIX) && (r.topics ?? []).includes(TOPIC) && isRepoId(r.full_name)

export type ChatList = { notModified: true; etag?: string } | { notModified: false; chats: ChatRef[]; etag?: string }

// The chats I own or was added to. With the first page's `etag` from last time, an
// unchanged first page answers 304 (free against the rate limit) and nothing else is read.
export async function listChats(run: Run, gh: string, etag?: string): Promise<ChatList | GhError> {
  const chats: ChatRef[] = []
  let first: string | undefined
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ghApi<GitHubRepo[]>(
      run,
      gh,
      `user/repos?affiliation=owner,collaborator&sort=full_name&per_page=${PER_PAGE}&page=${page}`,
      page === 1 && etag ? { headers: { 'If-None-Match': etag } } : {},
    )
    if (!res.ok) return res.error
    if (page === 1) {
      first = res.etag
      if (res.status === 304) return { notModified: true, ...(first ? { etag: first } : {}) }
    }
    if (!Array.isArray(res.data)) return unexpected
    for (const r of res.data) if (isChatRepo(r)) chats.push({ id: r.full_name, owner: r.owner.login, name: r.name })
    if (res.data.length < PER_PAGE) break
  }
  return { notModified: false, chats, ...(first ? { etag: first } : {}) }
}

export async function readMeta(run: Run, gh: string, id: string): Promise<ChatMeta | GhError> {
  if (!isRepoId(id)) return unexpected
  const res = await ghApi<ChatMeta>(run, gh, `repos/${id}/contents/${META_PATH}`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  })
  if (!res.ok) return res.error
  const m = res.data
  if (!m || (m.kind !== 'group' && m.kind !== 'dm') || typeof m.name !== 'string') return unexpected
  return { v: 1, kind: m.kind, name: m.name, createdBy: String(m.createdBy ?? '') }
}

export async function listMembers(run: Run, gh: string, id: string): Promise<string[] | GhError> {
  if (!isRepoId(id)) return unexpected
  const res = await ghApi<{ login: string }[]>(run, gh, `repos/${id}/collaborators?affiliation=all&per_page=${PER_PAGE}`)
  if (!res.ok) return res.error
  if (!Array.isArray(res.data)) return unexpected
  return res.data.map(u => u.login).filter(isLogin)
}

// A chat as the screens draw it: meta.json for its name and kind, collaborators for members.
export async function loadChat(run: Run, gh: string, ref: ChatRef): Promise<Conversation | GhError> {
  const meta = await readMeta(run, gh, ref.id)
  if ('message' in meta) return meta
  const members = await listMembers(run, gh, ref.id)
  if (!Array.isArray(members)) return members
  return { id: ref.id, name: meta.name, kind: meta.kind, memberIds: members, owner: ref.owner }
}

// Stop GitHub emailing every member on every message.
export async function muteChat(run: Run, gh: string, id: string): Promise<true | GhError> {
  if (!isRepoId(id)) return unexpected
  const res = await ghApi(run, gh, `repos/${id}/subscription`, {
    method: 'PUT',
    body: { subscribed: false, ignored: true },
  })
  return res.ok ? true : res.error
}

export type NewChat = { kind: 'group'; name: string; me: string } | { kind: 'dm'; me: string; with: string; name?: string }

export type Exists = { kind: 'exists'; id: string; message: string }

// Creates the repo, its topic, meta.json, the `chat` issue, mutes it and, for a DM,
// invites the other person. Every step is a write on the person's GitHub account.
// A group whose name is taken gets "-2", "-3"...; a DM repo that already exists on
// my account comes back as `exists`, so the caller opens it instead.
export async function createChat(run: Run, gh: string, spec: NewChat): Promise<Conversation | GhError | Exists> {
  if (!isLogin(spec.me) || (spec.kind === 'dm' && !isLogin(spec.with))) return unexpected
  const base = spec.kind === 'group' ? groupRepoName(spec.name) : dmRepoName(spec.me, spec.with)
  const name = spec.kind === 'group' ? spec.name.trim() : (spec.name ?? spec.with)
  if (!name) return { kind: 'unknown', message: 'Dê um nome ao grupo.' }

  let repo: GitHubRepo | undefined
  for (let attempt = 1; attempt <= 5 && !repo; attempt++) {
    const repoName = attempt === 1 ? base : `${base}-${attempt}`
    const res = await ghApi<GitHubRepo>(run, gh, 'user/repos', {
      method: 'POST',
      body: {
        name: repoName,
        description: DESCRIPTION,
        private: true,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        auto_init: false,
      },
    })
    if (res.ok) {
      if (!res.data?.full_name || !isRepoId(res.data.full_name)) return unexpected
      repo = res.data
    } else if (res.status === 422) {
      // The name is taken on this account.
      if (spec.kind === 'dm') return { kind: 'exists', id: `${spec.me}/${repoName}`, message: 'Essa conversa já existe.' }
    } else {
      return res.error
    }
  }
  if (!repo) return { kind: 'unknown', message: 'Já existem grupos demais com esse nome.' }
  const id = repo.full_name

  const meta: ChatMeta = { v: 1, kind: spec.kind, name, createdBy: spec.me }
  const steps: [string, { method: string; body: unknown }][] = [
    [`repos/${id}/topics`, { method: 'PUT', body: { names: [TOPIC] } }],
    [
      `repos/${id}/contents/${META_PATH}`,
      { method: 'PUT', body: { message: 'Start team chat', content: base64Utf8(`${JSON.stringify(meta, null, 2)}\n`) } },
    ],
    [`repos/${id}/labels`, { method: 'POST', body: { name: LABEL, color: 'D97757' } }],
    [`repos/${id}/issues`, { method: 'POST', body: { title: 'chat', labels: [LABEL] } }],
  ]
  for (const [path, opts] of steps) {
    const res = await ghApi(run, gh, path, opts)
    // A label that already exists is fine.
    if (!res.ok && !(path.endsWith('/labels') && res.status === 422)) return res.error
  }
  await muteChat(run, gh, id)

  const members = [spec.me]
  if (spec.kind === 'dm') {
    const invited = await addMember(run, gh, id, spec.with)
    if (invited !== true) return invited
    members.push(spec.with)
  }
  return { id, name, kind: spec.kind, memberIds: members, owner: repo.owner.login }
}

// --- Members -----------------------------------------------------------------

// Invites a person; their mod accepts the invitation on its own (acceptInvites).
export async function addMember(run: Run, gh: string, id: string, login: string): Promise<true | GhError> {
  if (!isRepoId(id) || !isLogin(login)) return unexpected
  const res = await ghApi(run, gh, `repos/${id}/collaborators/${login}`, { method: 'PUT', body: { permission: 'push' } })
  return res.ok ? true : res.error
}

// Leaving removes me as a collaborator. The owner cannot leave (MVP): the repo is theirs.
export async function leaveChat(run: Run, gh: string, chat: Conversation, me: string): Promise<true | GhError> {
  if (!isRepoId(chat.id) || !isLogin(me)) return unexpected
  if (chat.id.split('/')[0]!.toLowerCase() === me.toLowerCase()) {
    return { kind: 'unknown', message: 'Você criou este grupo e não pode sair dele.' }
  }
  const res = await ghApi(run, gh, `repos/${chat.id}/collaborators/${me}`, { method: 'DELETE' })
  return res.ok ? true : res.error
}

type GitHubInvitation = { id: number; repository?: GitHubRepo }

// Accepts invitations to chat repos (prefix `tc-` and our description) and mutes
// each one. Returns the chats joined; other invitations are left alone.
export async function acceptInvites(run: Run, gh: string): Promise<ChatRef[] | GhError> {
  const res = await ghApi<GitHubInvitation[]>(run, gh, `user/repository_invitations?per_page=${PER_PAGE}`)
  if (!res.ok) return res.error
  if (!Array.isArray(res.data)) return unexpected
  const joined: ChatRef[] = []
  for (const inv of res.data) {
    const r = inv.repository
    if (!r || !Number.isInteger(inv.id) || !isRepoId(r.full_name)) continue
    if (!r.name.toLowerCase().startsWith(PREFIX) || r.description !== DESCRIPTION) continue
    const ok = await ghApi(run, gh, `user/repository_invitations/${inv.id}`, { method: 'PATCH' })
    if (!ok.ok) continue
    await muteChat(run, gh, r.full_name)
    joined.push({ id: r.full_name, owner: r.owner.login, name: r.name })
  }
  return joined
}

// --- Messages ----------------------------------------------------------------

// Where the last read of a chat stopped. `since` is the newest `updated_at` seen
// (GitHub's filter is inclusive, so repeats are merged by id); `etag` belongs to
// the URL with that `since`, so an unchanged chat answers 304.
export type Cursor = { since?: string; etag?: string }

export type MessagePage = { messages: ChatMessage[]; cursor: Cursor }

export async function fetchMessages(run: Run, gh: string, id: string, cursor: Cursor = {}): Promise<MessagePage | GhError> {
  if (!isRepoId(id)) return unexpected
  const all: GitHubComment[] = []
  let etag: string | undefined
  for (let page = 1; page <= MAX_PAGES; page++) {
    const since = cursor.since ? `&since=${encodeURIComponent(cursor.since)}` : ''
    const res = await ghApi<GitHubComment[]>(
      run,
      gh,
      `repos/${id}/issues/${ISSUE}/comments?per_page=${PER_PAGE}&page=${page}${since}`,
      page === 1 && cursor.etag ? { headers: { 'If-None-Match': cursor.etag } } : {},
    )
    if (!res.ok) return res.error
    if (page === 1) {
      etag = res.etag
      if (res.status === 304) return { messages: [], cursor }
    }
    if (!Array.isArray(res.data)) return unexpected
    all.push(...res.data)
    if (res.data.length < PER_PAGE) break
  }
  const since = all.reduce<string | undefined>((max, c) => {
    const t = c.updated_at ?? c.created_at
    return !max || t > max ? t : max
  }, cursor.since)
  // The etag is kept only while `since` (and so the URL) stays the same.
  return {
    messages: all.filter(c => Number.isInteger(c.id)).map(c => toMessage(id, c)),
    cursor: { ...(since ? { since } : {}), ...(etag && since === cursor.since ? { etag } : {}) },
  }
}

export async function postMessage(
  run: Run,
  gh: string,
  id: string,
  text: string,
  data: MessageData = { kind: 'text' },
): Promise<ChatMessage | GhError> {
  if (!isRepoId(id)) return unexpected
  if (!text.trim()) return { kind: 'unknown', message: 'Mensagem vazia.' }
  const res = await ghApi<GitHubComment>(run, gh, `repos/${id}/issues/${ISSUE}/comments`, {
    method: 'POST',
    body: { body: formatBody(text, data) },
  })
  if (!res.ok) return res.error
  if (!res.data || !Number.isInteger(res.data.id)) return unexpected
  return toMessage(id, res.data)
}

// Adds new messages to a chat's list: by id (an edit replaces), sorted by time.
export function mergeMessages(have: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(have.map(m => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.at - b.at || Number(a.id) - Number(b.id))
}

// Messages from others newer than the last one I read (comment ids only grow).
export function unreadCount(messages: ChatMessage[], lastReadId: string | undefined, me: string): number {
  const last = Number(lastReadId ?? 0)
  return messages.filter(m => !m.pending && Number(m.id) > last && m.authorId.toLowerCase() !== me.toLowerCase()).length
}
