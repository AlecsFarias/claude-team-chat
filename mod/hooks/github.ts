// GitHub through the person's own `gh`: find it, check the sign-in, call the API.
// Pure over an injected runner so tests never start a process; in the mod pass
// `(argv, init) => $.process.run(argv, init)`. The token is never read: no
// `gh auth token`, no `--show-token`, and `gh auth status` text never leaves here.

import type { ChatUser, GhState, Profile } from '../types'

export type Run = (
  argv: readonly string[],
  init?: { timeoutMs?: number; stdin?: string; cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type GhError = { kind: 'not-found' | 'rate-limited' | 'network' | 'auth' | 'unknown'; message: string }

export type ApiResult<T> =
  | { ok: true; data: T; status: number; etag?: string }
  | { ok: false; error: GhError; status?: number }

const PROBE_MS = 5_000
const AUTH_MS = 15_000
const API_MS = 20_000
const FILE_MS = 10_000
const DOWNLOAD_S = 15

// GitHub logins: 1 to 39 letters, digits or single hyphens, not at either end.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

export const isLogin = (login: string) => LOGIN.test(login)

export const isGhError = (value: unknown): value is GhError =>
  typeof value === 'object' && value !== null && 'kind' in value && 'message' in value

// Where `gh` usually is: the session PATH first, then the common install folders.
export const ghCandidates = (home: string): string[] => [
  'gh',
  ...(home ? [`${home}/.local/bin/gh`] : []),
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
]

export async function homeDir(run: Run): Promise<string> {
  try {
    const { exitCode, stdout } = await run(['/bin/sh', '-c', 'printf %s "$HOME"'], { timeoutMs: PROBE_MS })
    const home = stdout.trim()
    return exitCode === 0 && home.startsWith('/') ? home : ''
  } catch {
    return ''
  }
}

export async function findGh(run: Run, home: string): Promise<string | null> {
  for (const gh of ghCandidates(home)) {
    try {
      const { exitCode, stdout } = await run([gh, '--version'], { timeoutMs: PROBE_MS })
      if (exitCode === 0 && /gh version/i.test(stdout)) return gh
    } catch {
      // Could not start: not installed there.
    }
  }
  return null
}

export type AuthStatus =
  | { state: 'logged-in'; login: string; scopes?: string[] }
  | { state: 'logged-out' }
  | { state: 'timeout' }
  | { state: 'unknown' }

// Reads `gh auth status -h github.com` (both the 2.4x+ "account" format and the
// older "as" one). With several accounts, the active one counts. `scopes` is
// absent when gh lists none (fine-grained tokens, some versions).
export function parseAuthStatus(text: string): AuthStatus {
  const head = /(Logged in to|Failed to log in to|Timeout trying to log in to) \S+ (?:account|as) ([A-Za-z0-9-]+)/
  const blocks: string[][] = []
  for (const line of text.split(/\r?\n/)) {
    if (head.test(line)) blocks.push([line])
    else blocks[blocks.length - 1]?.push(line)
  }
  if (blocks.length === 0) {
    return /not logged in|gh auth login/i.test(text) ? { state: 'logged-out' } : { state: 'unknown' }
  }
  const block = blocks.find(lines => lines.some(l => /Active account:\s*true/.test(l))) ?? blocks[0]!
  const [, verb, login = ''] = head.exec(block[0] ?? '') ?? []
  if (verb === 'Failed to log in to') return { state: 'logged-out' }
  if (verb === 'Timeout trying to log in to') return { state: 'timeout' }
  const scopesLine = block.map(l => /Token scopes:\s*(.*)$/.exec(l)?.[1]).find(s => s !== undefined)
  if (scopesLine === undefined) return { state: 'logged-in', login }
  const scopes = scopesLine
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => s && s !== 'none')
  return { state: 'logged-in', login, scopes }
}

export async function checkGh(run: Run, home: string): Promise<GhState> {
  const gh = await findGh(run, home)
  if (!gh) return { status: 'missing' }

  let auth: AuthStatus
  try {
    const out = await run([gh, 'auth', 'status', '-h', 'github.com'], { timeoutMs: AUTH_MS })
    auth = parseAuthStatus(`${out.stdout}\n${out.stderr}`)
  } catch {
    return { status: 'error', gh, message: 'O gh demorou demais para responder. Tente de novo.' }
  }
  if (auth.state === 'logged-out') return { status: 'logged-out', gh }
  if (auth.state === 'timeout') return { status: 'error', gh, message: NETWORK }
  if (auth.state === 'unknown') return { status: 'error', gh, message: 'Não deu para ler o login do gh.' }
  if (auth.scopes && !auth.scopes.includes('repo')) return { status: 'no-repo-scope', gh, login: auth.login }

  const me = await ghApi<GitHubUser>(run, gh, 'user')
  if (!me.ok) {
    // A rejected token means signing in again, which the logged-out screen offers.
    if (me.status === 401) return { status: 'logged-out', gh }
    return { status: 'error', gh, message: me.error.message }
  }
  if (!me.data || !isLogin(me.data.login)) return { status: 'error', gh, message: 'Resposta inesperada do GitHub.' }
  const profile: Profile = {
    id: me.data.login,
    handle: me.data.login,
    name: me.data.name || me.data.login,
    avatarUrl: me.data.avatar_url,
    htmlUrl: me.data.html_url || `https://github.com/${me.data.login}`,
  }
  return { status: 'ok', gh, profile }
}

type GitHubUser = {
  login: string
  name?: string | null
  avatar_url?: string
  html_url?: string
  type?: string
}

const NETWORK = 'Sem conexão com o GitHub. Confira a internet e tente de novo.'

// `gh api --include` prints the status line and headers, a blank line, then the body.
function parseIncluded(stdout: string) {
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout)
  if (!status) return null
  const cut = /\r?\n\r?\n/.exec(stdout)
  const head = cut ? stdout.slice(0, cut.index) : stdout
  const body = cut ? stdout.slice(cut.index + cut[0].length) : ''
  const headers: Record<string, string> = {}
  for (const line of head.split(/\r?\n/).slice(1)) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return { status: Number(status[1]), headers, body }
}

function httpError(status: number, headers: Record<string, string>, body: string): GhError {
  let message = ''
  try {
    message = String((JSON.parse(body) as { message?: unknown }).message ?? '')
  } catch {
    // Not JSON.
  }
  if (status === 429 || (status === 403 && (headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(message)))) {
    const reset = Number(headers['x-ratelimit-reset'])
    const minutes = reset > 0 ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000)) : 0
    return {
      kind: 'rate-limited',
      message: minutes
        ? `Limite de uso da API do GitHub atingido. Tente de novo em ${minutes} min.`
        : 'Limite de uso da API do GitHub atingido. Tente de novo daqui a pouco.',
    }
  }
  if (status === 404) return { kind: 'not-found', message: 'Não encontrado no GitHub.' }
  if (status === 401) return { kind: 'auth', message: 'O login do gh expirou. Entre com GitHub de novo.' }
  if (status === 403) return { kind: 'auth', message: 'O GitHub negou o acesso a isso.' }
  if (status >= 500) return { kind: 'unknown', message: `O GitHub está com problemas (HTTP ${status}). Tente de novo.` }
  return { kind: 'unknown', message: `O GitHub recusou o pedido (HTTP ${status}).` }
}

// No HTTP answer at all: gh could not reach GitHub or failed before sending.
function runError(stderr: string): GhError {
  if (/dial tcp|no such host|connection refused|network is unreachable|i\/o timeout|timeout|TLS handshake|could not resolve|connection reset/i.test(stderr)) {
    return { kind: 'network', message: NETWORK }
  }
  if (/gh auth login|authentication|not logged in/i.test(stderr)) {
    return { kind: 'auth', message: 'O gh não está logado. Entre com GitHub de novo.' }
  }
  return { kind: 'unknown', message: 'O gh falhou ao falar com o GitHub.' }
}

// One REST call. A 304 (after If-None-Match) is ok with no data, so polling can
// skip unchanged resources; gh exits 1 on it and on every 4xx/5xx, so the
// status comes from the included headers, not the exit code.
export async function ghApi<T = unknown>(
  run: Run,
  gh: string,
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const argv = [gh, 'api', '--include']
  if (opts.method) argv.push('--method', opts.method.toUpperCase())
  for (const [name, value] of Object.entries(opts.headers ?? {})) argv.push('-H', `${name}: ${value}`)
  const hasBody = opts.body !== undefined
  if (hasBody) argv.push('--input', '-')
  argv.push(path)

  let out: Awaited<ReturnType<Run>>
  try {
    out = await run(argv, { timeoutMs: API_MS, ...(hasBody ? { stdin: JSON.stringify(opts.body) } : {}) })
  } catch {
    return { ok: false, error: { kind: 'network', message: NETWORK } }
  }

  const res = parseIncluded(out.stdout)
  if (!res) return { ok: false, error: runError(out.stderr) }
  const etag = res.headers['etag']
  if (res.status === 304) return { ok: true, data: undefined as T, status: 304, ...(etag ? { etag } : {}) }
  if (res.status < 200 || res.status > 299) {
    return { ok: false, status: res.status, error: httpError(res.status, res.headers, res.body) }
  }
  let data: T
  try {
    data = (res.body.trim() ? JSON.parse(res.body) : undefined) as T
  } catch {
    return { ok: false, status: res.status, error: { kind: 'unknown', message: 'Resposta inesperada do GitHub.' } }
  }
  return { ok: true, data, status: res.status, ...(etag ? { etag } : {}) }
}

// A person by @login, as "Adicionar pelo @" needs it. Accepts a leading @.
export async function getUser(run: Run, gh: string, login: string): Promise<ChatUser | GhError> {
  const wanted = login.trim().replace(/^@/, '')
  if (!isLogin(wanted)) return { kind: 'not-found', message: `"${wanted}" não é um @ válido do GitHub.` }
  const res = await ghApi<GitHubUser>(run, gh, `users/${wanted}`)
  if (!res.ok) {
    return res.status === 404 ? { kind: 'not-found', message: `@${wanted} não existe no GitHub.` } : res.error
  }
  const user = res.data
  if (!user || !isLogin(user.login)) return { kind: 'unknown', message: 'Resposta inesperada do GitHub.' }
  if (user.type && user.type !== 'User') {
    return { kind: 'not-found', message: `@${user.login} é uma organização, não uma pessoa.` }
  }
  return { id: user.login, handle: user.login, name: user.name || user.login, avatarUrl: user.avatar_url }
}

const PNG_MAGIC = '89504e470d0a1a0a'

async function isPng(run: Run, file: string): Promise<boolean> {
  try {
    const { exitCode, stdout } = await run(['/usr/bin/od', '-An', '-tx1', '-N8', file], { timeoutMs: FILE_MS })
    return exitCode === 0 && stdout.replace(/\s+/g, '') === PNG_MAGIC
  } catch {
    return false
  }
}

// Asks the avatar server for a 64 px picture.
export function avatarAt64(url: string): string {
  if (/[?&]s=\d+/.test(url)) return url.replace(/([?&])s=\d+/, '$1s=64')
  return `${url}${url.includes('?') ? '&' : '?'}s=64`
}

// Downloads the avatar to `<cacheDir>/<login>.png` for the `Image` element, which
// reads PNG only; GitHub may serve JPEG, converted with macOS `sips` when present.
export async function fetchAvatar(run: Run, url: string, login: string, cacheDir: string): Promise<string | null> {
  if (!isLogin(login) || !/^https:\/\/[^\s]+$/.test(url) || !cacheDir.startsWith('/') || /[\0\n]/.test(cacheDir)) {
    return null
  }
  const name = login.toLowerCase()
  const tmp = `${cacheDir}/${name}.download`
  const out = `${cacheDir}/${name}.png`
  const ok = async (argv: string[], timeoutMs = FILE_MS) => {
    try {
      return (await run(argv, { timeoutMs })).exitCode === 0
    } catch {
      return false
    }
  }

  if (!(await ok(['/bin/mkdir', '-p', cacheDir]))) return null
  const curl = ['/usr/bin/curl', '-fsSL', '--max-time', String(DOWNLOAD_S), '-o', tmp, avatarAt64(url)]
  if (!(await ok(curl, (DOWNLOAD_S + 5) * 1000))) {
    await ok(['/bin/rm', '-f', tmp])
    return null
  }

  let made = false
  if (await isPng(run, tmp)) made = await ok(['/bin/mv', '-f', tmp, out])
  else made = (await ok(['/usr/bin/sips', '-s', 'format', 'png', tmp, '--out', out], 20_000)) && (await isPng(run, out))
  await ok(['/bin/rm', '-f', tmp])
  return made ? out : null
}

// The PNG as base64, for surfaces that draw it inside an `Svg` (desktop, mobile)
// instead of reading the file. Null when unreadable or too big for an `Svg`.
export async function pngBase64(run: Run, file: string): Promise<string | null> {
  if (!file.startsWith('/') || !file.endsWith('.png')) return null
  try {
    const { exitCode, stdout } = await run(['/usr/bin/base64', '-i', file], { timeoutMs: FILE_MS })
    const b64 = stdout.replace(/\s+/g, '')
    return exitCode === 0 && /^[A-Za-z0-9+/]+=*$/.test(b64) && b64.length < 100_000 ? b64 : null
  } catch {
    return null
  }
}
