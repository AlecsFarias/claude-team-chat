export type Presence = 'online' | 'away' | 'offline'

export type ChatUser = { id: string; name: string; handle: string; presence: Presence }

export type Profile = { id: string; name: string; handle: string }

export type Conversation = { id: string; name: string; kind: 'group' | 'dm'; memberIds: string[] }

export type ChatMessage = { id: string; conversationId: string; authorId: string; text: string; at: number }

export type View = 'chat' | 'members' | 'groups' | 'contacts' | 'profile'

declare module 'claude-code' {
  interface PluginState {
    'team-chat': {
      view: View
      conversationId: string
      profile: Profile
      contacts: ChatUser[]
      conversations: Conversation[]
      // Shaped: the first version stored messages under `roomId`.
      messages: Shaped<ChatMessage[]>
      unread: Record<string, number>
      draft: string
      groupDraft: string
      contactDraft: string
    }
  }
}
