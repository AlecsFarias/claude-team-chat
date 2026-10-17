// Keeps `$.state` in step with the chats on GitHub: discovers chats, accepts
// invitations, polls messages (the open chat every 20 s, the others every 5 min,
// with ETags), counts unread, and runs the actions that write (send, create a
// group, open a DM). The screens only read the atoms and call these functions.

import type { ChatMessage, Conversation, SyncState } from '../types'
import {
  acceptInvites,
  createChat,
  dmPeer,
  dmRepoName,
  fetchMessages,
  listChats,
  loadChat,
  mergeMessages,
  postMessage,
  unreadCount,
} from './chats'
import type { ChatRef, Cursor } from './chats'
import { isGhError } from './github'
import type { GhError, Run } from './github'

export const OPEN_MS = 20_000
export const OTHERS_MS = 5 * 60_000
// $.store key: the last comment id read, per chat id.
export const LAST_READ = 'lastRead'
const KEEP = 1000

export type Who = { gh: string; me: string }

// Module state: a reload starts over and reads every chat again (merged by id).
let timer: { cancel: () => void } | undefined
let busy = false
let chatsEtag: string | undefined
let lastList = 0
const cursors = new Map<string, Cursor>()
const fetchedAt = new Map<string, number>()

// One `$.state` value. The engine's scan only accepts `read`/`update` on an atom
// declared in the same file, so register.tsx builds these over its own atoms.
export type Slot<T> = { get: () => Promise<T>; set: (f: (value: T) => T) => Promise<void> }

// What the sync needs from the engine, so tests can hand in a plain object.
export type Host = {
  run: Run
  store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }
  every: (ms: number, fn: () => void) => { cancel: () => void }
  now: () => number
  conversations: Slot<Conversation[]>
  messages: Slot<ChatMessage[]>
  unread: Slot<Record<string, number>>
  // The chat on screen; read only.
  conversationId: Pick<Slot<string>, 'get'>
  sync: Slot<SyncState>
}

// For tests and sign-out: forget timers and cursors.
export function stopSync() {
  timer?.cancel()
  timer = undefined
  busy = false
  chatsEtag = undefined
  lastList = 0
  cursors.clear()
  fetchedAt.clear()
}

export function startSync(h: Host, who: Who) {
  if (timer) return
  timer = h.every(OPEN_MS, () => void tick(h, who))
  void tick(h, who)
}

async function fail(h: Host, error: GhError) {
  await h.sync.set(() => ({ status: 'error', message: error.message, at: h.now() }) as SyncState)
}

// One pass. Overlapping ticks are skipped, so a slow GitHub never piles up calls.
export async function tick(h: Host, who: Who, force = false) {
  if (busy) return
  busy = true
  try {
    const now = h.now()
    await h.sync.set(s => ({ ...s, status: 'syncing' }) as SyncState)
    if (force || now - lastList >= OTHERS_MS) {
      const listed = await refreshChats(h, who)
      if (isGhError(listed)) return void (await fail(h, listed))
      lastList = now
    }
    const openId = await h.conversationId.get()
    for (const chat of await h.conversations.get()) {
      const due = chat.id === openId ? OPEN_MS : OTHERS_MS
      if (!force && now - (fetchedAt.get(chat.id) ?? 0) < due - 1000) continue
      const got = await pullMessages(h, who, chat.id)
      if (isGhError(got)) return void (await fail(h, got))
    }
    await recount(h, who.me)
    await h.sync.set(() => ({ status: 'idle', at: h.now() }) as SyncState)
  } catch (err) {
    await fail(h, { kind: 'unknown', message: err instanceof Error ? err.message : String(err) })
  } finally {
    busy = false
  }
}

// Accepts invitations, then lists the chat repos and loads the ones not seen yet.
// Chats that disappeared (repo deleted, I left) are dropped with their messages.
export async function refreshChats(h: Host, who: Who): Promise<true | GhError> {
  const run = h.run
  const joined = await acceptInvites(run, who.gh)
  // An invitation that cannot be read is not worth stopping the chat for.
  const listed = await listChats(run, who.gh, isGhError(joined) || joined.length === 0 ? chatsEtag : undefined)
  if (isGhError(listed)) return listed
  chatsEtag = listed.etag
  if (listed.notModified) return true

  const have = await h.conversations.get()
  const known = new Map(have.map(c => [c.id, c]))
  const next: Conversation[] = []
  for (const ref of listed.chats) {
    const chat = known.get(ref.id) ?? (await loadOne(run, who.gh, ref))
    if (chat) next.push(chat)
  }
  const ids = new Set(next.map(c => c.id))
  await h.conversations.set(() => next)
  await h.messages.set(list => list.filter(m => ids.has(m.conversationId) || m.pending))
  for (const id of [...cursors.keys()]) if (!ids.has(id)) cursors.delete(id)
  return true
}

// A repo with the topic but a broken meta.json is skipped, not fatal.
async function loadOne(run: Run, gh: string, ref: ChatRef): Promise<Conversation | null> {
  const chat = await loadChat(run, gh, ref)
  return 'message' in chat ? null : chat
}

export async function pullMessages(h: Host, who: Who, id: string): Promise<true | GhError> {
  const page = await fetchMessages(h.run, who.gh, id, cursors.get(id))
  if (isGhError(page)) return page
  cursors.set(id, page.cursor)
  fetchedAt.set(id, h.now())
  if (page.messages.length) {
    await h.messages.set(list => {
      const mine = list.filter(m => m.conversationId === id)
      const rest = list.filter(m => m.conversationId !== id)
      return [...rest, ...mergeMessages(mine, page.messages).slice(-KEEP)]
    })
  }
  if (id === (await h.conversationId.get())) await markRead(h, id)
  return true
}

async function lastReadMap(h: Host): Promise<Record<string, string>> {
  const v = await h.store.get(LAST_READ)
  return v && typeof v === 'object' ? (v as Record<string, string>) : {}
}

// The open chat counts as read up to its newest message.
export async function markRead(h: Host, id: string) {
  const last = (await h.messages.get()).filter(m => m.conversationId === id && !m.pending).pop()
  if (last) {
    const map = await lastReadMap(h)
    if (map[id] !== last.id) await h.store.set(LAST_READ, { ...map, [id]: last.id })
  }
  await h.unread.set(u => (u[id] ? { ...u, [id]: 0 } : u))
}

export async function recount(h: Host, me: string) {
  const map = await lastReadMap(h)
  const all = await h.messages.get()
  const openId = await h.conversationId.get()
  const counts: Record<string, number> = {}
  for (const chat of await h.conversations.get()) {
    counts[chat.id] =
      chat.id === openId ? 0 : unreadCount(all.filter(m => m.conversationId === chat.id), map[chat.id], me)
  }
  await h.unread.set(() => counts)
}

// Shows the message at once (pending), then swaps in the posted comment. On a
// failure the pending one is removed and the error returned, so the screen can
// give the text back to the composer.
export async function sendMessage(
  h: Host,
  who: Who,
  id: string,
  text: string,
): Promise<ChatMessage | GhError> {
  const body = text.trim()
  if (!body) return { kind: 'unknown', message: 'Mensagem vazia.' }
  const temp: ChatMessage = {
    id: `pending-${h.now()}`,
    conversationId: id,
    authorId: who.me,
    text: body,
    at: h.now(),
    pending: true,
  }
  await h.messages.set(list => [...list, temp])
  const posted = await postMessage(h.run, who.gh, id, body)
  await h.messages.set(list => {
    const rest = list.filter(m => m.id !== temp.id)
    return isGhError(posted) ? rest : mergeMessages(rest, [posted])
  })
  if (isGhError(posted)) await fail(h, posted)
  else await markRead(h, id)
  return posted
}

// Creates the group's repo on GitHub and lists it.
export async function createGroup(h: Host, who: Who, name: string) {
  const made = await createChat(h.run, who.gh, { kind: 'group', name, me: who.me })
  // `exists` only comes back for a DM.
  if (made.kind === 'exists') return { kind: 'unknown', message: made.message } as GhError
  if (isGhError(made)) return made
  await h.conversations.set(l => [...l.filter(c => c.id !== made.id), made])
  return made
}

// The DM with `login`: the one already listed (either of us may own it), else one
// joined from a pending invitation, else a new repo with them invited.
export async function openDm(
  h: Host,
  who: Who,
  login: string,
): Promise<Conversation | GhError> {
  const find = async () =>
    (await h.conversations.get()).find(
      c => c.kind === 'dm' && dmPeer(c, who.me)?.toLowerCase() === login.toLowerCase(),
    ) ??
    (await h.conversations.get()).find(c => c.id.split('/')[1] === dmRepoName(who.me, login))
  const listed = await find()
  if (listed) return listed

  const refreshed = await refreshChats(h, who)
  if (!isGhError(refreshed)) {
    const joined = await find()
    if (joined) return joined
  }

  const run = h.run
  const made = await createChat(run, who.gh, { kind: 'dm', me: who.me, with: login })
  // Checked first: `exists` also has `kind` and `message`, like a GhError.
  const chat =
    made.kind === 'exists'
      ? await loadChat(run, who.gh, { id: made.id, owner: who.me, name: made.id.split('/')[1]! })
      : made
  if (isGhError(chat)) return chat
  await h.conversations.set(l => [...l.filter(c => c.id !== chat.id), chat])
  return chat
}
