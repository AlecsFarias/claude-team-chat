import type {
  BoxProps,
  SvgProps,
  ButtonProps,
  Color,
  ElementConstructor,
  ImageProps,
  InputProps,
  LinkProps,
  RenderChildren,
  TextProps,
} from 'claude-code'

import type { Avatar as AvatarFile, ChatMessage, ChatUser, Conversation, GhState, Profile, SyncState, View } from '../types'

export type Ui = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  // The mobile app draws no text field yet.
  Input?: ElementConstructor<InputProps>
  // Every surface has Link today; kept optional so a missing one falls back to text.
  Link?: ElementConstructor<LinkProps>
  // The terminal draws a PNG file; desktop and mobile draw an Svg instead.
  Image?: ElementConstructor<ImageProps>
  Svg?: ElementConstructor<SvgProps>
}

export type Actions = {
  go: (view: View) => void
  open: (conversationId: string) => void
  openDm: (userId: string) => void
  send: (text: string) => void
  setDraft: (text: string) => void
  createGroup: (name: string) => void
  setGroupDraft: (text: string) => void
  setGroupSearch: (text: string) => void
  setContactSearch: (text: string) => void
  addContact: (login: string) => void
  setContactDraft: (text: string) => void
  // Runs the `gh` check again from the setup screen.
  retryGh: () => void
  // Confirms the GitHub identity and leaves the setup screen.
  start: () => void
}

export type Ctx = {
  ui: Ui
  cols: number
  rows: number
  // Epoch ms of this draw; "ativo há X min" is measured against it.
  now: number
  view: View
  gh: GhState
  // Null until the person confirms their GitHub identity.
  profile: Profile | null
  contacts: ChatUser[]
  conversations: Conversation[]
  // Undefined until the person has a group or a direct chat.
  current?: Conversation
  messages: ChatMessage[]
  // The newest message of each conversation, for the list previews.
  lastMessages: Record<string, ChatMessage>
  unread: Record<string, number>
  // Downloaded GitHub pictures by login.
  avatars: Record<string, AvatarFile>
  draft: string
  groupDraft: string
  contactDraft: string
  // What the search fields of the group and contact lists hold.
  groupSearch: string
  contactSearch: string
  contactError: string
  // Actions under way, by name ('group', 'contact', 'dm'), with what to say.
  busy: Record<string, string>
  // The terminal spinner's frame; advances while something is loading.
  frame: number
  // The background sync with GitHub.
  sync: SyncState
  act: Actions
}

// Every screen past setup has a profile.
type SignedIn = Ctx & { profile: Profile }


const AUTHOR_COLORS: Color[] = ['suggestion', 'merged', 'autoAccept', 'ide', 'remember', 'planMode']

// The canvas palette (dark pane, clay accent). Raw colors are fine on every
// surface (`Color` admits hex); the terminal keeps theme keys where it reads better.
const P = {
  accent: '#D97757',
  onAccent: '#1F1E1C',
  bubble: '#302F2C',
  row: '#2E2D2A',
  tile: '#33312D',
  tileOn: '#3A2C25',
  accentSoft: '#E8916F',
  muted: '#A8A49C',
  line: '#3A3936',
}
// Avatar fills and the matching name colors, as in the canvas.
const FILLS = ['#7AA7E8', '#B49AE6', '#8CC48C', '#E0B25C', '#E88FA8', '#6FC2C2']
const NAMES = ['#9DBEF0', '#C7B5EE', '#A6D4A6', '#EBC57F', '#F0AEC0', '#93D3D3']
const ME_FILL = '#E8916F'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const activeAgo = (at: number | undefined, now: number): string => {
  if (at === undefined) return ''
  const ago = now - at
  if (ago < MINUTE) return 'ativo agora'
  if (ago < HOUR) return `ativo há ${Math.floor(ago / MINUTE)} min`
  if (ago < DAY) return `ativo há ${Math.floor(ago / HOUR)} h`
  return `ativo há ${Math.floor(ago / DAY)} d`
}

// Desktop and mobile draw pictures (Svg) and colors as the canvas does; the
// terminal is a grid of cells.
const gfx = (ctx: Ctx) => ctx.ui.Svg !== undefined

const meId = (ctx: Ctx) => ctx.profile?.id ?? ''

const colorIndex = (id: string) => {
  let sum = 0
  for (const ch of id) sum += ch.charCodeAt(0)
  return sum
}

const authorColor = (ctx: Ctx, id: string): Color => {
  if (gfx(ctx)) return id === meId(ctx) ? P.accentSoft : NAMES[colorIndex(id) % NAMES.length]!
  if (id === meId(ctx)) return 'claude'
  return AUTHOR_COLORS[colorIndex(id) % AUTHOR_COLORS.length] ?? 'suggestion'
}

const avatarFill = (ctx: Ctx, id: string) => (id === meId(ctx) ? ME_FILL : FILLS[colorIndex(id) % FILLS.length]!)

const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// "10:11" today, "ontem", else day/month: the time column of the lists.
const when = (at: number, now: number) => {
  const day = (t: number) => new Date(t).toDateString()
  if (day(at) === day(now)) return clock(at)
  if (day(at) === day(now - DAY)) return 'ontem'
  const d = new Date(at)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

const initials = (user: { name: string; handle?: string }) => {
  const words = user.name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0] ?? user.handle ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const matches = (query: string, ...texts: string[]) => {
  const q = query.trim().toLowerCase()
  return !q || texts.some(t => t.toLowerCase().includes(q))
}

const people = (ctx: SignedIn): ChatUser[] => [
  { ...ctx.profile, lastActiveAt: ctx.now },
  ...ctx.contacts,
]

const personById = (ctx: SignedIn, id: string) => people(ctx).find(p => p.id === id)

const titleOf = (c: Conversation) => (c.kind === 'group' ? `# ${c.name}` : `@ ${c.name}`)

const unreadOf = (ctx: Ctx, kind: Conversation['kind']) =>
  ctx.conversations
    .filter(c => c.kind === kind && c.id !== ctx.current?.id)
    .reduce((n, c) => n + (ctx.unread[c.id] ?? 0), 0)

// ── Pictures ─────────────────────────────────────────────────────────────────

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Stroke icons from the canvas, 24×24 paths.
const ICONS = {
  hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.3-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.6 2.6 3 5.2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  clip: '<path d="M20 11.5l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  task: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
}

const iconSvg = (paths: string, px: number, stroke: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

// An icon on a rounded tile, like the group icon of the canvas list.
const tileSvg = (paths: string, px: number, fill: string, stroke: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">` +
  `<rect width="${px}" height="${px}" rx="${Math.round(px * 0.28)}" fill="${fill}"/>` +
  `<g transform="translate(${px / 2 - 9} ${px / 2 - 9}) scale(0.75)" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`

// Graphical surfaces only; the terminal gets nothing (callers add a glyph).
// Each Svg needs real alt text: a blank one is not drawn on the desktop.
const ICON_ALT: Record<keyof typeof ICONS, string> = {
  hash: 'grupo',
  search: 'buscar',
  users: 'membros',
  chat: 'chat',
  file: 'arquivos',
  clip: 'anexar',
  spark: 'contexto',
  task: 'tarefa',
  plus: 'adicionar',
  user: 'perfil',
}

const Icon = (ctx: Ctx, name: keyof typeof ICONS, px: number, stroke = P.muted) => {
  const { Box, Svg } = ctx.ui
  if (!Svg) return ''
  return (
    <Box flexShrink={0}>
      <Svg source={iconSvg(ICONS[name], px, stroke)} alt={ICON_ALT[name]} width={px} height={px} />
    </Box>
  )
}

const Tile = (ctx: Ctx, name: keyof typeof ICONS, on: boolean) => {
  const { Box, Svg } = ctx.ui
  if (!Svg) return ''
  return (
    <Box flexShrink={0}>
      <Svg
        source={tileSvg(ICONS[name], 36, on ? P.tileOn : P.tile, on ? P.accentSoft : '#C9C5BC')}
        alt={ICON_ALT[name]}
        width={36}
        height={36}
      />
    </Box>
  )
}

// A control of a later MVP phase, in dark gray and not pressable (a Button has
// no disabled state), so the screen shows where the feature will live.
const OFF = '#5A5853'

const Soon = (ctx: Ctx, key: string, label: string, icon?: keyof typeof ICONS, pill = false) => {
  const { Box, Text } = ctx.ui
  const g = gfx(ctx)
  return (
    <Box
      key={key}
      flexDirection="row"
      gap={1}
      alignItems="center"
      flexShrink={0}
      borderStyle={g && pill ? 'round' : undefined}
      borderColor={g && pill ? OFF : undefined}
      paddingX={g && pill ? 1 : 0}
    >
      {icon ? Icon(ctx, icon, 14, OFF) : ''}
      <Text color={OFF} size="caption">
        {g ? label : `[${label}]`}
      </Text>
    </Box>
  )
}

type AvatarSize = 'sm' | 'md' | 'xl' | 'lg'

// Cells for the terminal's Image, CSS pixels for an Svg. A Box's width and
// height are cells on every surface, so the Svg's Box gets no size of its own.
const AVATAR_CELLS: Record<AvatarSize, { columns: number; rows: number; px: number }> = {
  sm: { columns: 2, rows: 1, px: 28 },
  md: { columns: 2, rows: 1, px: 32 },
  xl: { columns: 6, rows: 3, px: 56 },
  lg: { columns: 8, rows: 4, px: 84 },
}

// A round avatar as SVG: the GitHub photo when we have it, else initials on color.
const avatarSvg = (ctx: Ctx, user: { id: string; name: string; handle?: string }, px: number) => {
  const png = ctx.avatars[user.id]?.png
  const r = px / 2
  const inner = png
    ? `<clipPath id="c"><circle cx="${r}" cy="${r}" r="${r}"/></clipPath>` +
      `<image href="data:image/png;base64,${png}" width="${px}" height="${px}" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${r}" cy="${r}" r="${r}" fill="${avatarFill(ctx, user.id)}"/>` +
      `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="600" font-size="${Math.round(px * 0.38)}" fill="${P.onAccent}">${escapeXml(initials(user))}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">${inner}</svg>`
}

// The GitHub photo where the surface can draw it; else initials.
const Avatar = (ctx: Ctx, user: { id: string; name: string; handle?: string }, size: AvatarSize) => {
  const { Box, Text, Image, Svg } = ctx.ui
  const { columns, rows, px } = AVATAR_CELLS[size]
  const file = ctx.avatars[user.id]?.file
  const alt = initials(user)
  const color = authorColor(ctx, user.id)

  if (Svg) {
    return (
      <Box flexShrink={0}>
        <Svg source={avatarSvg(ctx, user, px)} alt={alt} width={px} height={px} />
      </Box>
    )
  }
  if (Image && file && file.endsWith('.png')) {
    return (
      <Box width={columns} height={rows} flexShrink={0}>
        <Image source={{ file, format: 'png' }} columns={columns} rows={rows} alt={alt} />
      </Box>
    )
  }
  if (size === 'sm' || size === 'md') {
    return (
      <Box width={columns} flexShrink={0}>
        <Text bold color={color}>
          {alt.padEnd(2)}
        </Text>
      </Box>
    )
  }
  return (
    <Box
      width={columns}
      height={rows}
      flexShrink={0}
      borderStyle="round"
      borderColor={color}
      justifyContent="center"
      alignItems="center"
    >
      <Text bold color={color}>
        {alt}
      </Text>
    </Box>
  )
}

// ── Shared pieces ────────────────────────────────────────────────────────────

// A Box has one border for all four sides, so a rule is a line of text cut at
// the pane's edge.
const Divider = (ctx: Ctx) => {
  const { Box, Text } = ctx.ui
  // One row, clipped: a truncated Text would end in "…" where the pane ends.
  return (
    <Box height={1} overflow="hidden" flexShrink={0}>
      <Text color={gfx(ctx) ? P.line : undefined} dimColor={!gfx(ctx)} wrap="wrap">
        {'─'.repeat(Math.max(400, ctx.cols))}
      </Text>
    </Box>
  )
}

// Where "←" leads: back to the chat that is open, named, or just "Chat".
const backLabel = (ctx: Ctx) => (ctx.current ? titleOf(ctx.current) : 'Chat')

// Small all-caps label over a list or field, like the canvas's section titles.
const Section = (ctx: Ctx, text: string) => {
  const { Text } = ctx.ui
  return (
    <Text dimColor mono size="caption" wrap="truncate">
      {text.toUpperCase()}
    </Text>
  )
}

// The canvas's orange count: a pill on graphical surfaces, "●2" on the terminal.
const Badge = (ctx: Ctx, n: number, key: string) => {
  const { Box, Text } = ctx.ui
  if (n <= 0) return ''
  if (!gfx(ctx)) {
    return (
      <Text key={key} bold color="claude">
        ●{n}
      </Text>
    )
  }
  return (
    <Box key={key} backgroundColor={P.accent} borderStyle="round" borderColor={P.accent} paddingX={1} flexShrink={0}>
      <Text bold size="caption" color={P.onAccent}>
        {n}
      </Text>
    </Box>
  )
}

// ── Loading ──────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// An arc that turns by itself (SMIL in an interactive Svg), so the desktop
// needs no redraws to animate it.
const spinnerSvg = (px: number, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24">` +
  `<circle cx="12" cy="12" r="9" fill="none" stroke="${color}" stroke-opacity="0.25" stroke-width="3"/>` +
  `<path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round">` +
  `<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/>` +
  `</path></svg>`

// A turning spinner and what is happening: an animated Svg on the desktop, a
// braille frame that the mod advances on the terminal.
const Spinner = (ctx: Ctx, key: string, label: string, size: 'sm' | 'md' = 'sm') => {
  const { Box, Text, Svg } = ctx.ui
  const px = size === 'sm' ? 14 : 20
  return (
    <Box key={key} flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
      {Svg ? (
        <Svg source={spinnerSvg(px, P.accent)} alt="carregando" width={px} height={px} isInteractive />
      ) : (
        <Text color="claude">{FRAMES[ctx.frame % FRAMES.length]}</Text>
      )}
      {label ? (
        <Text dimColor size={size === 'sm' ? 'caption' : undefined}>
          {label}
        </Text>
      ) : (
        ''
      )}
    </Box>
  )
}

// A big centered loader for a screen whose content is on its way.
const Loading = (ctx: Ctx, key: string, title: string, line: string) => {
  const { Box, Text } = ctx.ui
  return (
    <Box key={key} flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" gap={1}>
      {Spinner(ctx, `${key}-spin`, '', 'md')}
      <Text bold>{title}</Text>
      <Text dimColor>{line}</Text>
    </Box>
  )
}

// Nothing synced yet: the first pass over GitHub is still running.
const firstSync = (ctx: Ctx) => ctx.sync.status === 'syncing' && ctx.sync.at === undefined

// A rounded chat bubble: background and a same-colored round border on
// graphical surfaces (the border gives the corners), plain color on the terminal.
// A message still being posted is drawn faded.
const Bubble = (ctx: Ctx, key: string, text: string, mine: boolean, pending = false) => {
  const { Box, Text } = ctx.ui
  if (!gfx(ctx)) {
    return (
      <Box key={key} backgroundColor={mine && !pending ? 'claude' : undefined} paddingX={mine ? 1 : 0}>
        <Text color={mine && !pending ? 'inverseText' : undefined} dimColor={pending}>
          {text}
        </Text>
      </Box>
    )
  }
  const bg = mine ? (pending ? '#7A4A36' : P.accent) : P.bubble
  return (
    <Box key={key} backgroundColor={bg} borderStyle="round" borderColor={bg} paddingX={1} flexShrink={1}>
      <Text color={mine ? P.onAccent : undefined}>{text}</Text>
    </Box>
  )
}

const AppHeader = (ctx: SignedIn) => {
  const { Box, Text, Button } = ctx.ui
  const groups = unreadOf(ctx, 'group')
  const dms = unreadOf(ctx, 'dm')

  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingY={gfx(ctx) ? 1 : 0}>
      <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
        {Avatar(ctx, ctx.profile, 'md')}
        <Box flexDirection="column" flexShrink={1}>
          <Button key="nav-profile" plain onPress={() => ctx.act.go('profile')}>
            <Text bold>{ctx.profile.name}</Text>
          </Button>
          <Text dimColor size="caption" wrap="truncate">
            @{ctx.profile.handle} · perfil
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
        {ctx.sync.status === 'syncing' ? Spinner(ctx, 'sync-spin', '') : ''}
        <Button
          key="nav-groups"
          variant={ctx.view === 'groups' ? 'primary' : 'secondary'}
          onPress={() => ctx.act.go(ctx.view === 'groups' ? 'chat' : 'groups')}
        >
          Grupos
        </Button>
        {Badge(ctx, groups, 'badge-groups')}
        <Button
          key="nav-contacts"
          variant={ctx.view === 'contacts' ? 'primary' : 'secondary'}
          onPress={() => ctx.act.go(ctx.view === 'contacts' ? 'chat' : 'contacts')}
        >
          Contatos
        </Button>
        {Badge(ctx, dms, 'badge-contacts')}
      </Box>
    </Box>
  )
}

// "← Chat   Grupos · 3": back on the left, as in the canvas.
const SubHeader = (ctx: Ctx, back: string, title: string, detail?: string, end?: RenderChildren) => {
  const { Box, Text, Button } = ctx.ui
  return (
    <Box flexDirection="row" gap={2} alignItems="center" paddingY={gfx(ctx) ? 1 : 0}>
      <Button key="back" plain dimColor onPress={() => ctx.act.go('chat')}>
        ← {back}
      </Button>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate">
          <Text bold>{title}</Text>
          {detail ? <Text dimColor> · {detail}</Text> : ''}
        </Text>
      </Box>
      {end ?? ''}
    </Box>
  )
}

// A search field over a list (the canvas's "Buscar grupos").
const Search = (ctx: Ctx, key: string, placeholder: string, value: string, onInput: (v: string) => void) => {
  const { Box, Input } = ctx.ui
  if (!Input) return ''
  return (
    <Box flexDirection="row" gap={1} alignItems="center" width="100%" marginTop={1}>
      {Icon(ctx, 'search', 16)}
      <Box flexGrow={1}>
        <Input key={key} placeholder={placeholder} value={value} submitLabel="buscar" onInput={onInput} onSubmit={onInput} />
      </Box>
    </Box>
  )
}

// The field at the bottom of a screen, full width: an optional caps label,
// the field (the surface draws it and its Enter button), then an error or a
// hint split left and right like the canvas.
const Composer = (
  ctx: Ctx,
  field: Omit<InputProps, 'autoFocus'>,
  hint: [string, string?],
  opts: { label?: string; error?: string; tools?: RenderChildren; busy?: string } = {},
) => {
  const { Box, Text, Input } = ctx.ui
  const input = Input ? <Input autoFocus {...field} /> : <Text dimColor>Envio indisponível aqui.</Text>
  return (
    <Box flexDirection="column" width="100%" gap={gfx(ctx) ? 1 : 0}>
      {Divider(ctx)}
      {opts.tools ? (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {opts.tools}
        </Box>
      ) : (
        ''
      )}
      {opts.label ? Section(ctx, opts.label) : ''}
      {gfx(ctx) ? (
        // A column stretches its children across: the app's field sizes itself,
        // so this is the most room the API lets us give it.
        <Box flexDirection="column" alignItems="stretch" width="100%" flexGrow={1}>
          {input}
        </Box>
      ) : (
        <Box borderStyle="round" borderColor={opts.error ? 'error' : 'promptBorder'} paddingX={1}>
          {input}
        </Box>
      )}
      {opts.busy ? (
        Spinner(ctx, `${field.key}-busy`, opts.busy)
      ) : opts.error ? (
        <Text color="error" wrap="truncate">
          {opts.error}
        </Text>
      ) : (
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text dimColor size="caption" wrap="truncate">
            {hint[0]}
          </Text>
          {hint[1] ? (
            <Text dimColor size="caption" wrap="truncate">
              {hint[1]}
            </Text>
          ) : (
            ''
          )}
        </Box>
      )}
    </Box>
  )
}

// The sync failed: say why until the next pass works.
const SyncError = (ctx: Ctx) => {
  const { Box, Text } = ctx.ui
  if (ctx.sync.status !== 'error') return ''
  return (
    <Box key="sync-error" flexDirection="row" gap={1} paddingY={gfx(ctx) ? 1 : 0}>
      <Text color="warning" size="caption" wrap="truncate">
        ⚠ Sem sincronizar com o GitHub: {ctx.sync.message} Tentando de novo…
      </Text>
    </Box>
  )
}

const Frame = (ctx: SignedIn, ...children: RenderChildren[]) => {
  const { Box } = ctx.ui
  return (
    <Box flexDirection="column" height={ctx.rows} width="100%">
      {AppHeader(ctx)}
      {Divider(ctx)}
      {SyncError(ctx)}
      {children}
    </Box>
  )
}

// A centered "nothing here yet" block: an icon, a title, a line, buttons.
const Empty = (
  ctx: Ctx,
  key: string,
  icon: keyof typeof ICONS,
  title: string,
  line: string,
  ...actions: RenderChildren[]
) => {
  const { Box, Text } = ctx.ui
  return (
    <Box key={key} flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" gap={1}>
      {Tile(ctx, icon, true)}
      <Text bold>{title}</Text>
      <Text dimColor>{line}</Text>
      {actions.length > 0 ? (
        <Box flexDirection="row" gap={1}>
          {actions}
        </Box>
      ) : (
        ''
      )}
    </Box>
  )
}

// "@login · ativo há 5 min", without the dot when there is no activity yet.
const handleLine = (ctx: Ctx, p: ChatUser) => {
  const ago = activeAgo(p.lastActiveAt, ctx.now)
  return ago ? `@${p.handle} · ${ago}` : `@${p.handle}`
}

// ── Setup ────────────────────────────────────────────────────────────────────

const Command = (ctx: Ctx, cmd: string) => {
  const { Text } = ctx.ui
  return (
    <Text bold mono color="claude">
      {cmd}
    </Text>
  )
}

const RetryButton = (ctx: Ctx) => {
  const { Button } = ctx.ui
  return (
    <Button key="setup-retry" variant="secondary" onPress={() => ctx.act.retryGh()}>
      Tentar de novo
    </Button>
  )
}

// One "something to fix" block: a title, how to fix it, and Retry.
const Problem = (ctx: Ctx, title: string, ...lines: RenderChildren[]) => {
  const { Box, Text } = ctx.ui
  return (
    <Box flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={2} paddingY={1}>
      <Text bold color="warning">
        {title}
      </Text>
      {lines}
      <Box flexDirection="row">{RetryButton(ctx)}</Box>
    </Box>
  )
}

const GhStep = (ctx: Ctx) => {
  const { Box, Text, Button } = ctx.ui
  const gh = ctx.gh

  switch (gh.status) {
    case 'checking':
      return Spinner(ctx, 'gh-checking', 'Verificando o gh e a sua conta do GitHub…', 'md')
    case 'missing':
      return Problem(
        ctx,
        'gh não encontrado',
        <Text>
          O chat usa o GitHub CLI. Instale em{' '}
          <Text color="claude">https://cli.github.com</Text> (no Mac: {Command(ctx, 'brew install gh')}).
        </Text>,
        <Text>Depois rode {Command(ctx, 'gh auth login')} no terminal.</Text>,
      )
    case 'logged-out':
      return Problem(
        ctx,
        'gh sem login',
        <Text>Rode {Command(ctx, 'gh auth login')} no terminal e entre com a sua conta do GitHub.</Text>,
      )
    case 'no-repo-scope':
      return Problem(
        ctx,
        'Falta o escopo repo',
        <Text dimColor>Conectado como @{gh.login}.</Text>,
        <Text>
          O chat guarda as conversas em repositórios privados. Rode {Command(ctx, 'gh auth refresh -s repo')} no
          terminal.
        </Text>,
      )
    case 'error':
      return Problem(ctx, 'Não deu para falar com o gh', <Text>{gh.message}</Text>)
    case 'ok':
      return (
        <Box flexDirection="column" gap={2}>
          <Box
            flexDirection="row"
            gap={2}
            alignItems="center"
            borderStyle="round"
            borderColor={gfx(ctx) ? P.line : undefined}
            borderDimColor={!gfx(ctx)}
            backgroundColor={gfx(ctx) ? '#2B2A27' : undefined}
            paddingX={2}
            paddingY={1}
          >
            {Avatar(ctx, gh.profile, gfx(ctx) ? 'md' : 'lg')}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text bold>{gh.profile.name}</Text>
              <Text dimColor mono size="caption">
                @{gh.profile.handle}
              </Text>
            </Box>
            <Text color="success" size="caption">
              ✓ Conectado pelo gh
            </Text>
          </Box>
          <Button key="setup-start" variant="primary" onPress={() => ctx.act.start()}>
            Começar
          </Button>
          <Text dimColor size="caption">
            Sua identidade é a do GitHub. Nada da sua sessão é compartilhado sem você confirmar.
          </Text>
        </Box>
      )
  }
}

const SetupView = (ctx: Ctx) => {
  const { Box, Text } = ctx.ui
  return (
    <Box flexDirection="column" height={ctx.rows} width="100%" justifyContent="center" paddingX={2} gap={2}>
      {gfx(ctx) ? (
        Tile(ctx, 'chat', true)
      ) : (
        <Text bold color="claude">
          ✻ Team Chat
        </Text>
      )}
      <Box flexDirection="column" gap={1}>
        <Text bold size="title">
          Trabalhe junto, cada um com seu Claude
        </Text>
        <Text dimColor>
          Converse com o time, compartilhe o contexto da sua sessão e passe tarefas sem copiar e colar.
        </Text>
      </Box>
      {GhStep(ctx)}
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

// Keep the newest runs that fit, so the list sits on the composer. A bubble
// takes its text's lines, plus its border's two rows where one is drawn.
const fitRuns = (ctx: SignedIn, runs: Run[], rows: number): Run[] => {
  const width = Math.max(10, ctx.cols - 8)
  const border = gfx(ctx) ? 2 : 0
  const kept: Run[] = []
  let used = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!
    const lines = run.items.reduce((n, m) => n + Math.ceil((m.text.length + 4) / width) + border, 0)
    const cost = 2 + lines
    if (used + cost > rows && kept.length > 0) break
    used += cost
    kept.unshift(run)
  }
  return kept
}

// A group run as the canvas draws it: avatar, colored name and time, bubbles.
// Your own: right-aligned, no avatar, orange bubbles. In a direct chat, no
// names or avatars: bubbles and the time under them.
const MessageRun = (ctx: SignedIn, run: Run, direct: boolean) => {
  const { Box, Text } = ctx.ui
  const mine = run.authorId === ctx.profile.id
  const person = personById(ctx, run.authorId) ?? { id: run.authorId, name: run.authorId, handle: run.authorId }
  const first = run.items[0]!
  const time = (
    <Text dimColor mono size="caption">
      {clock(direct ? run.at : first.at)}
    </Text>
  )
  const bubbles = run.items.map(m => Bubble(ctx, m.id, m.text, mine, m.pending))
  const sending = run.items.some(m => m.pending) ? Spinner(ctx, `sending-${first.id}`, 'enviando…') : ''

  if (direct || mine) {
    return (
      <Box
        key={`run-${first.id}`}
        flexDirection="column"
        alignItems={mine ? 'flex-end' : 'flex-start'}
        marginTop={1}
        rowGap="xs"
      >
        {direct ? (
          ''
        ) : (
          <Text>
            <Text bold>você</Text> {time}
          </Text>
        )}
        {bubbles}
        {sending}
        {direct ? time : ''}
      </Box>
    )
  }
  return (
    <Box key={`run-${first.id}`} flexDirection="row" gap={1} marginTop={1}>
      {Avatar(ctx, person, 'sm')}
      <Box flexDirection="column" flexShrink={1} alignItems="flex-start" rowGap="xs">
        <Text>
          <Text bold color={authorColor(ctx, run.authorId)}>
            {person.name}
          </Text>{' '}
          {time}
        </Text>
        {bubbles}
      </Box>
    </Box>
  )
}

// No group or chat yet: say so and point at the two ways to start one.
const EmptyChat = (ctx: SignedIn) => {
  const { Button } = ctx.ui
  if (firstSync(ctx)) {
    return Frame(ctx, Loading(ctx, 'loading-chats', 'Buscando suas conversas', 'Lendo seus grupos e conversas no GitHub…'))
  }
  return Frame(
    ctx,
    Empty(
      ctx,
      'empty',
      'chat',
      'Nenhuma conversa ainda',
      'Crie um grupo ou adicione alguém pelo @ do GitHub.',
      <Button key="empty-groups" variant="primary" onPress={() => ctx.act.go('groups')}>
        Criar grupo
      </Button>,
      <Button key="empty-contacts" variant="secondary" onPress={() => ctx.act.go('contacts')}>
        Adicionar contato
      </Button>,
    ),
  )
}

// The chat's own header: "# geral" over "5 membros", or for a direct chat
// the person's avatar, name and "ativo há … · conversa direta".
const ChatHead = (ctx: SignedIn, c: Conversation, other: ChatUser | undefined) => {
  const { Box, Text, Button } = ctx.ui
  const ago = other ? activeAgo(other.lastActiveAt, ctx.now) : ''
  // Say plainly which chat is open: its kind, then its name in heading size.
  const sub = other
    ? ['Conversa direta', ago].filter(Boolean).join(' · ')
    : `Grupo · ${plural(c.memberIds.length, 'membro', 'membros')}`
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingY={gfx(ctx) ? 1 : 0}>
      <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
        {other ? Avatar(ctx, other, 'md') : Tile(ctx, 'hash', true)}
        <Box flexDirection="column" flexShrink={1}>
          <Text dimColor mono size="caption" wrap="truncate">
            {sub.toUpperCase()}
          </Text>
          <Text bold size="heading" wrap="truncate">
            {other ? other.name : titleOf(c)}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
        {other ? (
          Soon(ctx, 'soon-profile', 'Ver perfil', 'user')
        ) : (
          <Box flexDirection="row" gap={2} alignItems="center">
            {Soon(ctx, 'soon-files', 'Arquivos', 'file')}
            <Box flexDirection="row" gap={1} alignItems="center">
              {Icon(ctx, 'users', 16, '#C9C5BC')}
              <Button key="show-members" plain dimColor onPress={() => ctx.act.go('members')}>
                Membros
              </Button>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  )
}

const ChatView = (ctx: SignedIn) => {
  const { Box, Text } = ctx.ui
  const c = ctx.current
  if (!c) return EmptyChat(ctx)
  const direct = c.kind === 'dm'
  const other = direct ? personById(ctx, c.memberIds.find(id => id !== ctx.profile.id) ?? '') : undefined
  // App header, dividers, chat header, the composer and its hint.
  const area = Math.max(3, ctx.rows - (gfx(ctx) ? 12 : 9))
  const runs = fitRuns(ctx, toRuns(ctx.messages), area)

  return Frame(
    ctx,
    ChatHead(ctx, c, other),
    Divider(ctx),
    <Box
      key="messages"
      flexDirection="column"
      flexGrow={1}
      height={area}
      justifyContent="flex-end"
      overflow="hidden"
    >
      {direct ? (
        <Box key="day" justifyContent="center">
          <Text dimColor mono size="caption">
            só vocês dois veem esta conversa
          </Text>
        </Box>
      ) : (
        ''
      )}
      {runs.length === 0 && ctx.sync.status === 'syncing'
        ? Loading(ctx, 'loading-messages', 'Carregando mensagens', 'Buscando a conversa no GitHub…')
        : runs.length === 0
        ? Empty(
            ctx,
            'no-messages',
            'chat',
            'Nenhuma mensagem ainda',
            direct ? `Comece a conversa com ${other?.name ?? c.name}.` : `Diga oi para ${titleOf(c)}.`,
          )
        : runs.map(run => MessageRun(ctx, run, direct))}
    </Box>,
    Composer(
      ctx,
      {
        key: 'composer',
        placeholder: `Mensagem para ${direct ? other?.name ?? c.name : titleOf(c)}`,
        submitLabel: 'enviar',
        value: ctx.draft,
        onInput: value => ctx.act.setDraft(value),
        onSubmit: value => ctx.act.send(value),
      },
      ['enter envia', 'só nesta sessão por enquanto'],
      {
        tools: [
          Soon(ctx, 'soon-attach', 'Anexar', 'clip', true),
          Soon(ctx, 'soon-share', 'Compartilhar contexto', 'spark', true),
          Soon(ctx, 'soon-task', 'Passar tarefa', 'task', true),
        ],
      },
    ),
  )
}

// ── Lists ────────────────────────────────────────────────────────────────────

// One person: name over "@login · ativo há …".
const PersonInfo = (ctx: SignedIn, p: ChatUser) => {
  const { Box, Text } = ctx.ui
  const me = p.id === ctx.profile.id
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      <Text bold wrap="truncate">
        {me ? `${p.name} (você)` : p.name}
      </Text>
      <Text dimColor size="caption" wrap="truncate">
        {me ? `@${p.handle}` : handleLine(ctx, p)}
      </Text>
    </Box>
  )
}

// A list row: a keyed Box that lights on hover, as the canvas rows do.
const Row = (ctx: Ctx, key: string, current: boolean, ...children: RenderChildren[]) => {
  const { Box } = ctx.ui
  const g = gfx(ctx)
  return (
    <Box
      key={key}
      flexDirection="row"
      gap={1}
      alignItems="center"
      paddingX={g ? 1 : 0}
      paddingY={g ? 1 : 0}
      backgroundColor={g && current ? P.row : undefined}
      hover={g ? { backgroundColor: P.row } : undefined}
    >
      {children}
    </Box>
  )
}

// ── Members ──────────────────────────────────────────────────────────────────

const MembersView = (ctx: SignedIn) => {
  const { Box } = ctx.ui
  const c = ctx.current
  if (!c) return EmptyChat(ctx)
  const members = c.memberIds
    .map(id => personById(ctx, id))
    .filter((p): p is ChatUser => p !== undefined)
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))

  return Frame(
    ctx,
    SubHeader(ctx, titleOf(c), 'Membros', `${members.length}`, Soon(ctx, 'soon-add-member', 'Adicionar', 'plus', true)),
    Divider(ctx),
    <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
      {Section(ctx, 'Mais recentes primeiro')}
      {members.map(p => Row(ctx, `person-${p.id}`, false, Avatar(ctx, p, 'md'), PersonInfo(ctx, p)))}
    </Box>,
    c.kind === 'group' ? Divider(ctx) : '',
    c.kind === 'group' ? (
      <Box flexDirection="row" justifyContent="flex-end" paddingY={gfx(ctx) ? 1 : 0}>
        {Soon(ctx, 'soon-leave', 'Sair do grupo')}
      </Box>
    ) : (
      ''
    ),
  )
}

// ── Groups ───────────────────────────────────────────────────────────────────

// "Carla: to testando agora" under the group name.
const preview = (ctx: SignedIn, c: Conversation) => {
  const m = ctx.lastMessages[c.id]
  if (!m) return { text: 'Nenhuma mensagem ainda', at: undefined }
  const who = m.authorId === ctx.profile.id ? 'você' : (personById(ctx, m.authorId)?.name ?? m.authorId).split(' ')[0]
  return { text: `${who}: ${m.text}`, at: m.at }
}

const GroupsView = (ctx: SignedIn) => {
  const { Box, Text, Button } = ctx.ui
  const all = ctx.conversations.filter(c => c.kind === 'group')
  const groups = all
    .filter(g => matches(ctx.groupSearch, g.name))
    .sort((a, b) => (ctx.lastMessages[b.id]?.at ?? 0) - (ctx.lastMessages[a.id]?.at ?? 0))

  return Frame(
    ctx,
    SubHeader(ctx, backLabel(ctx), 'Grupos', `${all.length}`),
    Divider(ctx),
    all.length > 0 ? Search(ctx, 'group-search', 'Buscar grupos', ctx.groupSearch, v => ctx.act.setGroupSearch(v)) : '',
    <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
      {all.length === 0 && firstSync(ctx)
        ? Loading(ctx, 'loading-groups', 'Buscando seus grupos', 'Lendo os repositórios do chat no GitHub…')
        : all.length === 0
        ? Empty(ctx, 'no-groups', 'hash', 'Nenhum grupo ainda', 'Crie o primeiro aqui embaixo e chame o time.')
        : groups.length === 0
          ? <Text dimColor>Nenhum grupo com “{ctx.groupSearch.trim()}”.</Text>
          : groups.map(g => {
              const cur = g.id === ctx.current?.id
              const n = cur ? 0 : ctx.unread[g.id] ?? 0
              const last = preview(ctx, g)
              return Row(
                ctx,
                `group-row-${g.id}`,
                cur,
                Tile(ctx, 'hash', cur),
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Button key={`group-${g.id}`} plain onPress={() => ctx.act.open(g.id)}>
                    <Text bold={cur}>{gfx(ctx) ? g.name : `# ${g.name}`}</Text>
                  </Button>
                  <Text dimColor size="caption" wrap="truncate">
                    {last.text}
                  </Text>
                </Box>,
                <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
                  <Text dimColor mono size="caption">
                    {last.at ? when(last.at, ctx.now) : ' '}
                  </Text>
                  {cur ? (
                    <Text bold color={gfx(ctx) ? P.accentSoft : 'claude'} size="caption">
                      aberto no chat
                    </Text>
                  ) : n > 0 ? (
                    Badge(ctx, n, `group-badge-${g.id}`)
                  ) : (
                    <Text dimColor size="caption">
                      {plural(g.memberIds.length, 'membro', 'membros')}
                    </Text>
                  )}
                </Box>,
                <Button key={`group-open-${g.id}`} variant="secondary" onPress={() => ctx.act.open(g.id)}>
                  {cur ? 'Voltar' : 'Abrir'}
                </Button>,
              )
            })}
    </Box>,
    Composer(
      ctx,
      {
        key: 'new-group',
        placeholder: 'Nome do grupo',
        submitLabel: 'criar',
        value: ctx.groupDraft,
        onInput: value => ctx.act.setGroupDraft(value),
        onSubmit: value => ctx.act.createGroup(value),
      },
      ['enter cria o grupo e abre o chat'],
      { label: 'Novo grupo', busy: ctx.busy.group },
    ),
  )
}

// ── Contacts ─────────────────────────────────────────────────────────────────

const ContactsView = (ctx: SignedIn) => {
  const { Box, Text, Button } = ctx.ui
  const dmUnread = (userId: string) => {
    const dm = ctx.conversations.find(c => c.kind === 'dm' && c.memberIds.includes(userId))
    return dm && dm.id !== ctx.current?.id ? ctx.unread[dm.id] ?? 0 : 0
  }
  const list = ctx.contacts
    .filter(p => matches(ctx.contactSearch, p.name, p.handle))
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))

  return Frame(
    ctx,
    SubHeader(ctx, backLabel(ctx), 'Contatos', `${ctx.contacts.length}`),
    Divider(ctx),
    ctx.contacts.length > 0
      ? Search(ctx, 'contact-search', 'Buscar contatos', ctx.contactSearch, v => ctx.act.setContactSearch(v))
      : '',
    <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
      {ctx.contacts.length === 0 ? (
        Empty(ctx, 'no-contacts', 'users', 'Nenhum contato ainda', 'Adicione alguém pelo @ do GitHub aqui embaixo.')
      ) : list.length === 0 ? (
        <Text dimColor>Nenhum contato com “{ctx.contactSearch.trim()}”.</Text>
      ) : (
        <Box flexDirection="column">
          {Section(ctx, 'Mais recentes primeiro')}
          {list.map(p =>
            Row(
              ctx,
              `contact-row-${p.id}`,
              false,
              Avatar(ctx, p, 'md'),
              PersonInfo(ctx, p),
              Badge(ctx, dmUnread(p.id), `contact-badge-${p.id}`),
              <Button key={`contact-${p.id}`} variant="secondary" onPress={() => ctx.act.openDm(p.id)}>
                Conversar
              </Button>,
            ),
          )}
        </Box>
      )}
    </Box>,
    Composer(
      ctx,
      {
        key: 'new-contact',
        placeholder: '@ do GitHub',
        submitLabel: 'adicionar',
        value: ctx.contactDraft,
        onInput: value => ctx.act.setContactDraft(value),
        onSubmit: value => ctx.act.addContact(value),
      },
      ['Funciona com qualquer @ do GitHub. Se o @ não existir, avisamos aqui.'],
      { label: 'Adicionar pelo @ do GitHub', error: ctx.contactError, busy: ctx.busy.contact ?? ctx.busy.dm },
    ),
  )
}

// ── Profile ──────────────────────────────────────────────────────────────────

const ProfileView = (ctx: SignedIn) => {
  const { Box, Text, Link } = ctx.ui
  const p = ctx.profile
  const Item = (key: string, label: string, value: RenderChildren) => (
    <Box key={key} flexDirection="row" justifyContent="space-between" gap={2} paddingY={gfx(ctx) ? 1 : 0}>
      <Text>{label}</Text>
      {value}
    </Box>
  )
  return Frame(
    ctx,
    SubHeader(ctx, backLabel(ctx), 'Perfil'),
    Divider(ctx),
    <Box flexDirection="column" alignItems="center" gap={1} marginTop={2} marginBottom={1}>
      {Avatar(ctx, p, 'lg')}
      <Text bold size="heading">
        {p.name}
      </Text>
      <Text dimColor mono>
        @{p.handle}
      </Text>
    </Box>,
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={gfx(ctx) ? P.line : undefined}
      borderDimColor={!gfx(ctx)}
      paddingX={2}
    >
      {Item('name', 'Nome', <Text dimColor wrap="truncate">{p.name}</Text>)}
      {Item('user', 'Usuário', <Text dimColor wrap="truncate">@{p.handle}</Text>)}
      {Item(
        'github',
        'GitHub',
        Link ? <Link href={p.htmlUrl}>Ver no GitHub</Link> : <Text color="claude">{p.htmlUrl}</Text>,
      )}
    </Box>,
    <Box marginTop={1} paddingX={1}>
      <Text dimColor size="caption">
        Nome e foto vêm do seu perfil no GitHub. Para mudar, edite lá.
      </Text>
    </Box>,
  )
}

export const renderApp = (ctx: Ctx) => {
  if (ctx.view === 'setup' || ctx.profile === null) return SetupView(ctx)
  const signed: SignedIn = { ...ctx, profile: ctx.profile }
  switch (ctx.view) {
    case 'members':
      return MembersView(signed)
    case 'groups':
      return GroupsView(signed)
    case 'contacts':
      return ContactsView(signed)
    case 'profile':
      return ProfileView(signed)
    default:
      return ChatView(signed)
  }
}
