import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ChatMessage, ChatUser, Conversation, View } from '../types'
import {
  CONTACTS,
  CONVERSATIONS,
  DEFAULT_CONVERSATION,
  ME,
  PROFILE,
  SEED_MESSAGES,
  SEED_UNREAD,
} from './mock'
import { renderApp } from './views'
import type { Actions } from './views'

const PANE = 'team-chat'
const TITLE = 'Chat'

const view = atom({ plugin: 'team-chat', key: 'view' } as const, 'chat' as View)
const conversationId = atom({ plugin: 'team-chat', key: 'conversationId' } as const, DEFAULT_CONVERSATION.id)
const profile = atom({ plugin: 'team-chat', key: 'profile' } as const, PROFILE)
const contacts = atom({ plugin: 'team-chat', key: 'contacts' } as const, CONTACTS)
const conversations = atom({ plugin: 'team-chat', key: 'conversations' } as const, CONVERSATIONS)
const messages = atom({ plugin: 'team-chat', key: 'messages' } as const, SEED_MESSAGES, { shape: 'v2' })
const unread = atom({ plugin: 'team-chat', key: 'unread' } as const, SEED_UNREAD)
const draft = atom({ plugin: 'team-chat', key: 'draft' } as const, '')
const groupDraft = atom({ plugin: 'team-chat', key: 'groupDraft' } as const, '')
const contactDraft = atom({ plugin: 'team-chat', key: 'contactDraft' } as const, '')

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'chat', description: 'Abrir a aba de chat' })

    return next(e)
  })

  on('command.run', { command: 'chat' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Chat aberto.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined

    const currentView = await read($, view)
    const currentId = await read($, conversationId)
    const allConversations = await read($, conversations)
    const allMessages = await read($, messages)
    const current = allConversations.find(c => c.id === currentId) ?? DEFAULT_CONVERSATION

    const open = async (id: string) => {
      await update($, conversationId, () => id)
      await update($, unread, u => ({ ...u, [id]: 0 }))
      await update($, view, () => 'chat' as View)
    }

    const act: Actions = {
      go: next => void update($, view, () => next),
      open: id => void open(id),
      openDm: async userId => {
        const list = await read($, conversations)
        let dm = list.find(c => c.kind === 'dm' && c.memberIds.includes(userId))
        if (!dm) {
          const person = (await read($, contacts)).find(p => p.id === userId)
          const created: Conversation = {
            id: `dm-${userId}`,
            name: person?.name ?? userId,
            kind: 'dm',
            memberIds: [ME, userId],
          }
          await update($, conversations, l => [...l, created])
          dm = created
        }
        await open(dm.id)
      },
      send: async value => {
        const text = value.trim()
        if (!text) return
        const msg: ChatMessage = {
          id: `m${Date.now()}`,
          conversationId: current.id,
          authorId: ME,
          text,
          at: Date.now(),
        }
        await update($, messages, list => [...list, msg].slice(-1000))
        await update($, draft, () => '')
      },
      setDraft: value => void update($, draft, () => value),
      createGroup: async value => {
        const name = value.trim().replace(/^#\s*/, '')
        if (!name) return
        const id = `g-${slug(name)}-${Date.now().toString(36)}`
        const group: Conversation = { id, name, kind: 'group', memberIds: [ME] }
        await update($, conversations, l => [...l, group])
        await update($, groupDraft, () => '')
        await open(id)
      },
      setGroupDraft: value => void update($, groupDraft, () => value),
      addContact: async value => {
        const name = value.trim()
        if (!name) return
        const handle = slug(name)
        const person: ChatUser = { id: `u-${handle}-${Date.now().toString(36)}`, name, handle, presence: 'offline' }
        await update($, contacts, l => [...l, person])
        await update($, contactDraft, () => '')
      },
      setContactDraft: value => void update($, contactDraft, () => value),
    }

    return renderApp({
      ui: { Box, Text, Button, Input },
      cols: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      view: currentView,
      profile: await read($, profile),
      contacts: await read($, contacts),
      conversations: allConversations,
      current,
      messages: allMessages.filter(m => m.conversationId === current.id),
      unread: await read($, unread),
      draft: await read($, draft),
      groupDraft: await read($, groupDraft),
      contactDraft: await read($, contactDraft),
      act,
    })
  })
}
