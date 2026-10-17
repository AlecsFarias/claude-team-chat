import type {
  BoxProps,
  ButtonProps,
  Color,
  ElementConstructor,
  InputProps,
  RenderChildren,
  TextProps,
} from 'claude-code'

import type { ChatMessage, ChatUser, Conversation, Presence, Profile, View } from '../types'
import { ME } from './mock'

export type Ui = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  // The mobile app draws no text field yet.
  Input?: ElementConstructor<InputProps>
}

export type Actions = {
  go: (view: View) => void
  open: (conversationId: string) => void
  openDm: (userId: string) => void
  send: (text: string) => void
  setDraft: (text: string) => void
  createGroup: (name: string) => void
  setGroupDraft: (text: string) => void
  addContact: (name: string) => void
  setContactDraft: (text: string) => void
}

export type Ctx = {
  ui: Ui
  cols: number
  rows: number
  view: View
  profile: Profile
  contacts: ChatUser[]
  conversations: Conversation[]
  current: Conversation
  messages: ChatMessage[]
  unread: Record<string, number>
  draft: string
  groupDraft: string
  contactDraft: string
  act: Actions
}

const PRESENCE_COLOR: Record<Presence, Color> = {
  online: 'success',
  away: 'warning',
  offline: 'inactive',
}

const PRESENCE_LABEL: Record<Presence, string> = {
  online: 'online',
  away: 'ausente',
  offline: 'offline',
}

const AUTHOR_COLORS: Color[] = ['suggestion', 'merged', 'autoAccept', 'ide', 'remember', 'planMode']

const authorColor = (id: string): Color => {
  if (id === ME) return 'claude'
  let sum = 0
  for (const ch of id) sum += ch.charCodeAt(0)
  return AUTHOR_COLORS[sum % AUTHOR_COLORS.length] ?? 'suggestion'
}

const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const people = (ctx: Ctx): ChatUser[] => [
  { ...ctx.profile, presence: 'online' },
  ...ctx.contacts,
]

const personById = (ctx: Ctx, id: string) => people(ctx).find(p => p.id === id)

const titleOf = (c: Conversation) => (c.kind === 'group' ? `# ${c.name}` : `@ ${c.name}`)

const unreadOf = (ctx: Ctx, kind: Conversation['kind']) =>
  ctx.conversations
    .filter(c => c.kind === kind && c.id !== ctx.current.id)
    .reduce((n, c) => n + (ctx.unread[c.id] ?? 0), 0)

// ── Shared pieces ────────────────────────────────────────────────────────────

const Divider = (ctx: Ctx) => {
  const { Text } = ctx.ui
  return (
    <Text dimColor wrap="truncate">
      {'─'.repeat(Math.max(1, ctx.cols))}
    </Text>
  )
}

const AppHeader = (ctx: Ctx) => {
  const { Box, Text, Button } = ctx.ui
  const groups = unreadOf(ctx, 'group')
  const dms = unreadOf(ctx, 'dm')

  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Button key="nav-profile" plain onPress={() => ctx.act.go('profile')}>
        <Text color="success">● </Text>
        <Text bold>{ctx.profile.name}</Text>
        <Text dimColor> · editar perfil</Text>
      </Button>
      <Box flexDirection="row" gap={1}>
        <Button
          key="nav-groups"
          variant={ctx.view === 'groups' ? 'primary' : 'secondary'}
          onPress={() => ctx.act.go(ctx.view === 'groups' ? 'chat' : 'groups')}
        >
          Grupos
          {groups > 0 ? <Text color="claude"> {groups}</Text> : ''}
        </Button>
        <Button
          key="nav-contacts"
          variant={ctx.view === 'contacts' ? 'primary' : 'secondary'}
          onPress={() => ctx.act.go(ctx.view === 'contacts' ? 'chat' : 'contacts')}
        >
          Contatos
          {dms > 0 ? <Text color="claude"> {dms}</Text> : ''}
        </Button>
      </Box>
    </Box>
  )
}

const SubHeader = (ctx: Ctx, title: string, detail?: string) => {
  const { Box, Text, Button } = ctx.ui
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text>
        <Text bold>{title}</Text>
        {detail ? <Text dimColor> · {detail}</Text> : ''}
      </Text>
      <Button key="back" plain onPress={() => ctx.act.go('chat')}>
        ← voltar ao chat
      </Button>
    </Box>
  )
}

const Composer = (
  ctx: Ctx,
  field: Omit<InputProps, 'autoFocus'>,
  hint: string,
) => {
  const { Box, Text, Input } = ctx.ui
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="claude" paddingX={1}>
        {Input ? <Input autoFocus {...field} /> : <Text dimColor>Envio indisponível aqui.</Text>}
      </Box>
      <Text dimColor size="caption" wrap="truncate">
        {'  '}
        {hint}
      </Text>
    </Box>
  )
}

const Frame = (ctx: Ctx, ...children: RenderChildren[]) => {
  const { Box } = ctx.ui
  return (
    <Box flexDirection="column" height={ctx.rows} width="100%">
      {AppHeader(ctx)}
      {Divider(ctx)}
      {children}
    </Box>
  )
}

// ── Chat ─────────────────────────────────────────────────────────────────────

type Run = { authorId: string; at: number; items: ChatMessage[] }

const toRuns = (list: ChatMessage[]): Run[] => {
  const runs: Run[] = []
  for (const m of list) {
    const last = runs[runs.length - 1]
    if (last && last.authorId === m.authorId && m.at - last.at < 5 * 60_000) {
      last.items.push(m)
      last.at = m.at
    } else {
      runs.push({ authorId: m.authorId, at: m.at, items: [m] })
    }
  }
  return runs
}

// Keep the newest runs that fit, so the list sits on the composer.
const fitRuns = (runs: Run[], rows: number, cols: number): Run[] => {
  const width = Math.max(10, cols - 4)
  const kept: Run[] = []
  let used = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!
    const lines = run.items.reduce((n, m) => n + Math.ceil((m.text.length + 2) / width), 0)
    const cost = 2 + lines
    if (used + cost > rows && kept.length > 0) break
    used += cost
    kept.unshift(run)
  }
  return kept
}

const MessageRun = (ctx: Ctx, run: Run) => {
  const { Box, Text } = ctx.ui
  const mine = run.authorId === ME
  const color = authorColor(run.authorId)
  const name = mine ? 'você' : personById(ctx, run.authorId)?.name ?? run.authorId
  const first = run.items[0]!

  return (
    <Box
      key={`run-${first.id}`}
      flexDirection="column"
      alignItems={mine ? 'flex-end' : 'flex-start'}
      marginTop={1}
    >
      <Text>
        <Text bold color={color}>
          {name}
        </Text>
        <Text dimColor> {clock(first.at)}</Text>
      </Text>
      {run.items.map(m =>
        mine ? (
          <Text key={m.id}>
            {m.text}
            <Text color={color}> ▕</Text>
          </Text>
        ) : (
          <Text key={m.id}>
            <Text color={color}>▏ </Text>
            {m.text}
          </Text>
        ),
      )}
    </Box>
  )
}

const ChatView = (ctx: Ctx) => {
  const { Box, Text, Button } = ctx.ui
  const c = ctx.current
  const other = c.kind === 'dm' ? personById(ctx, c.memberIds.find(id => id !== ME) ?? '') : undefined
  // App header, two dividers, chat header, composer (3) and its hint.
  const area = Math.max(3, ctx.rows - 8)
  const runs = fitRuns(toRuns(ctx.messages), area, ctx.cols)

  return Frame(
    ctx,
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text>
        <Text bold>{titleOf(c)}</Text>
        {other ? (
          <Text color={PRESENCE_COLOR[other.presence]}> ● {PRESENCE_LABEL[other.presence]}</Text>
        ) : (
          <Text dimColor> · {c.memberIds.length} membros</Text>
        )}
      </Text>
      <Button key="show-members" plain onPress={() => ctx.act.go('members')}>
        ≡ membros
      </Button>
    </Box>,
    Divider(ctx),
    <Box
      key="messages"
      flexDirection="column"
      flexGrow={1}
      height={area}
      justifyContent="flex-end"
      overflow="hidden"
    >
      {runs.length === 0 ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor>Nenhuma mensagem ainda. Diga oi!</Text>
        </Box>
      ) : (
        runs.map(run => MessageRun(ctx, run))
      )}
    </Box>,
    Composer(
      ctx,
      {
        key: 'composer',
        placeholder: `Mensagem para ${titleOf(c)}`,
        submitLabel: 'enviar',
        value: ctx.draft,
        onInput: value => ctx.act.setDraft(value),
        onSubmit: value => ctx.act.send(value),
      },
      'enter envia · offline, as mensagens ficam nesta sessão',
    ),
  )
}

// ── Members ──────────────────────────────────────────────────────────────────

const PersonRow = (ctx: Ctx, p: ChatUser) => {
  const { Text } = ctx.ui
  return (
    <Text key={`person-${p.id}`} wrap="truncate">
      <Text color={PRESENCE_COLOR[p.presence]}>● </Text>
      <Text bold={p.id === ME}>{p.id === ME ? `${p.name} (você)` : p.name}</Text>
      <Text dimColor>
        {'  '}@{p.handle} · {PRESENCE_LABEL[p.presence]}
      </Text>
    </Text>
  )
}

const MembersView = (ctx: Ctx) => {
  const { Box } = ctx.ui
  const c = ctx.current
  const members = c.memberIds
    .map(id => personById(ctx, id))
    .filter((p): p is ChatUser => p !== undefined)

  return Frame(
    ctx,
    SubHeader(ctx, `Membros de ${titleOf(c)}`, `${members.length}`),
    <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1} gap={0}>
      {members.map(p => PersonRow(ctx, p))}
    </Box>,
  )
}

// ── Groups ───────────────────────────────────────────────────────────────────

const GroupsView = (ctx: Ctx) => {
  const { Box, Text, Button } = ctx.ui
  const groups = ctx.conversations.filter(c => c.kind === 'group')

  return Frame(
    ctx,
    SubHeader(ctx, 'Grupos', `${groups.length}`),
    <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
      {groups.map(g => {
        const n = g.id === ctx.current.id ? 0 : ctx.unread[g.id] ?? 0
        return (
          <Button key={`group-${g.id}`} plain onPress={() => ctx.act.open(g.id)}>
            <Text bold={g.id === ctx.current.id}># {g.name}</Text>
            <Text dimColor>  {g.memberIds.length} membros</Text>
            {n > 0 ? <Text color="claude">  {n} novas</Text> : ''}
          </Button>
        )
      })}
    </Box>,
    Composer(
      ctx,
      {
        key: 'new-group',
        label: 'Novo grupo',
        placeholder: 'nome do grupo',
        submitLabel: 'criar',
        value: ctx.groupDraft,
        onInput: value => ctx.act.setGroupDraft(value),
        onSubmit: value => ctx.act.createGroup(value),
      },
      'enter cria o grupo e abre o chat',
    ),
  )
}

// ── Contacts ─────────────────────────────────────────────────────────────────

const ContactsView = (ctx: Ctx) => {
  const { Box, Text, Button } = ctx.ui
  const dmUnread = (userId: string) => {
    const dm = ctx.conversations.find(c => c.kind === 'dm' && c.memberIds.includes(userId))
    return dm && dm.id !== ctx.current.id ? ctx.unread[dm.id] ?? 0 : 0
  }

  return Frame(
    ctx,
    SubHeader(ctx, 'Contatos', `${ctx.contacts.length}`),
    <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
      {ctx.contacts.length === 0 && <Text dimColor>Nenhum contato ainda.</Text>}
      {ctx.contacts.map(p => {
        const n = dmUnread(p.id)
        return (
          <Button key={`contact-${p.id}`} plain onPress={() => ctx.act.openDm(p.id)}>
            <Text color={PRESENCE_COLOR[p.presence]}>● </Text>
            <Text>{p.name}</Text>
            <Text dimColor>  @{p.handle} · {PRESENCE_LABEL[p.presence]}</Text>
            {n > 0 ? <Text color="claude">  {n} novas</Text> : ''}
          </Button>
        )
      })}
    </Box>,
    Composer(
      ctx,
      {
        key: 'new-contact',
        label: 'Adicionar',
        placeholder: 'nome do contato',
        submitLabel: 'adicionar',
        value: ctx.contactDraft,
        onInput: value => ctx.act.setContactDraft(value),
        onSubmit: value => ctx.act.addContact(value),
      },
      'enter adiciona · clique num contato para conversar',
    ),
  )
}

// ── Profile ──────────────────────────────────────────────────────────────────

const ProfileView = (ctx: Ctx) => {
  const { Box, Text } = ctx.ui
  return Frame(
    ctx,
    SubHeader(ctx, 'Perfil'),
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1} marginTop={1}>
      <Text bold size="heading">
        {ctx.profile.name}
      </Text>
      <Text dimColor>@{ctx.profile.handle}</Text>
      <Text> </Text>
      <Text dimColor>A edição de perfil chega em breve.</Text>
    </Box>,
  )
}

export const renderApp = (ctx: Ctx) => {
  switch (ctx.view) {
    case 'members':
      return MembersView(ctx)
    case 'groups':
      return GroupsView(ctx)
    case 'contacts':
      return ContactsView(ctx)
    case 'profile':
      return ProfileView(ctx)
    default:
      return ChatView(ctx)
  }
}
