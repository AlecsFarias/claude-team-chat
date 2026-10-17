// A person is a GitHub user; `id` and `handle` are both the GitHub login.
export type ChatUser = {
  id: string
  name: string
  handle: string
  // https://avatars.githubusercontent.com/... from the GitHub API.
  avatarUrl?: string
  // Epoch ms of their last message seen in any chat; drives "ativo há X min".
  lastActiveAt?: number
}

export type Profile = {
  id: string
  name: string
  handle: string
  avatarUrl?: string
  // https://github.com/<login>
  htmlUrl: string
}

// What `gh` looks like on this machine, as the setup screen shows it.
export type GhState =
  | { status: 'checking' }
  | { status: 'missing' }
  | { status: 'logged-out'; gh: string }
  | { status: 'no-repo-scope'; gh: string; login: string }
  | { status: 'error'; gh?: string; message: string }
  | { status: 'ok'; gh: string; profile: Profile }

// A downloaded avatar: the PNG file and, when it could be read, its base64.
export type Avatar = { file: string; png?: string }

// A chat is a private GitHub repo: `id` is its full name, "owner/tc-...".
export type Conversation = {
  id: string
  name: string
  kind: 'group' | 'dm'
  memberIds: string[]
  // GitHub login that owns the repo (who created the chat).
  owner?: string
}

// What `.team-chat/meta.json` holds in each chat repo.
export type ChatMeta = { v: 1; kind: 'group' | 'dm'; name: string; createdBy: string }

// The structured part of a message, from its `<!-- team-chat:v1 {...} -->` marker.
export type MessageData =
  | { kind: 'text'; viaClaude?: boolean }
  | { kind: 'file'; path: string; name: string; size: number; mime: string; viaClaude?: boolean }
  | {
      kind: 'context'
      title: string
      summary: string
      source: 'summary' | 'last-answer' | 'changes'
      files: { path: string; added: number; removed: number }[]
      viaClaude?: boolean
    }
  | { kind: 'task'; to: string; title: string; details: string; context?: unknown; viaClaude?: boolean }

// `id` is the GitHub comment id; `pending` while it is still being posted.
export type ChatMessage = {
  id: string
  conversationId: string
  authorId: string
  text: string
  at: number
  data?: MessageData
  pending?: boolean
}

// The background sync with GitHub, for a status line or an error banner.
export type SyncState =
  | { status: 'idle'; at?: number }
  | { status: 'syncing'; at?: number }
  | { status: 'error'; message: string; at: number }

export type View = 'setup' | 'chat' | 'members' | 'groups' | 'contacts' | 'profile'

declare module 'claude-code' {
  interface PluginState {
    'team-chat': {
      view: View
      gh: GhState
      // Shaped: v1 defaulted to the sample group.
      conversationId: Shaped<string>
      // Shaped: v1 had a mock profile with no avatar or GitHub link; null until signed in.
      profile: Shaped<Profile | null>
      // Shaped: v1 carried a `presence` field; v2 started with sample people.
      contacts: Shaped<ChatUser[]>
      // Shaped: v1 started with sample groups.
      conversations: Shaped<Conversation[]>
      // Shaped: the first version stored messages under `roomId`.
      messages: Shaped<ChatMessage[]>
      // Shaped: v1 started with sample counts.
      unread: Shaped<Record<string, number>>
      // Shaped: v1 held only the file path. Avatar pictures by login: the local
      // PNG for the terminal's `Image`, and its base64 for an `Svg` elsewhere.
      avatars: Shaped<Record<string, Avatar>>
      draft: string
      groupDraft: string
      contactDraft: string
      groupSearch: string
      contactSearch: string
      // Error from the last "Adicionar pelo @" attempt, shown under the field.
      contactError: string
      // Background sync with GitHub (hooks/sync.ts).
      sync: SyncState
      // Actions under way ('group', 'contact', 'dm') and the line the UI shows.
      busy: Record<string, string>
      // The terminal spinner's frame; ticks only while something loads.
      frame: number
    }
  }
}
