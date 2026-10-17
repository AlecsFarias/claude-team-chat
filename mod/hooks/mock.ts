import type { ChatMessage, ChatUser, Conversation, Profile } from '../types'

// Placeholder data until there is a real connection.
export const ME = 'me'

export const PROFILE: Profile = { id: ME, name: 'Alecsander Farias', handle: 'alecs' }

export const CONTACTS: ChatUser[] = [
  { id: 'ana', name: 'Ana Souza', handle: 'ana', presence: 'online' },
  { id: 'bruno', name: 'Bruno Lima', handle: 'bruno', presence: 'away' },
  { id: 'carla', name: 'Carla Mendes', handle: 'carla', presence: 'online' },
  { id: 'diego', name: 'Diego Rocha', handle: 'diego', presence: 'offline' },
]

export const DEFAULT_CONVERSATION: Conversation = {
  id: 'geral',
  name: 'geral',
  kind: 'group',
  memberIds: [ME, 'ana', 'bruno', 'carla', 'diego'],
}

export const CONVERSATIONS: Conversation[] = [
  DEFAULT_CONVERSATION,
  { id: 'ajuda', name: 'ajuda', kind: 'group', memberIds: [ME, 'ana', 'diego'] },
  { id: 'random', name: 'random', kind: 'group', memberIds: [ME, 'bruno', 'carla'] },
  { id: 'dm-ana', name: 'Ana Souza', kind: 'dm', memberIds: [ME, 'ana'] },
]

const minutesAgo = (n: number) => Date.now() - n * 60_000

export const SEED_MESSAGES: ChatMessage[] = [
  { id: 's1', conversationId: 'geral', authorId: 'ana', text: 'bom dia, pessoal!', at: minutesAgo(42) },
  { id: 's2', conversationId: 'geral', authorId: 'ana', text: 'quem vem pra call das 10?', at: minutesAgo(41) },
  { id: 's3', conversationId: 'geral', authorId: 'bruno', text: 'alguém já testou o mod novo?', at: minutesAgo(30) },
  { id: 's4', conversationId: 'geral', authorId: ME, text: 'to fazendo a UI agora, já já mando', at: minutesAgo(20) },
  { id: 's5', conversationId: 'geral', authorId: 'carla', text: 'to testando agora, a aba abre de boa', at: minutesAgo(12) },
  { id: 's6', conversationId: 'ajuda', authorId: 'diego', text: 'como abro o chat de novo depois de fechar?', at: minutesAgo(90) },
  { id: 's7', conversationId: 'ajuda', authorId: 'ana', text: 'usa /chat', at: minutesAgo(88) },
  { id: 's8', conversationId: 'random', authorId: 'bruno', text: 'café ou chá?', at: minutesAgo(200) },
  { id: 's9', conversationId: 'dm-ana', authorId: 'ana', text: 'oi! me chama quando puder', at: minutesAgo(5) },
]

export const SEED_UNREAD: Record<string, number> = { ajuda: 2, 'dm-ana': 1 }
