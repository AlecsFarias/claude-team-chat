// A tiny GitHub in memory for the chat tests: the REST calls the mod makes
// through `gh api --include`, answered as a given user, with repos, invitations,
// issue comments and ETags. Nothing here reaches a real gh or GitHub.

import type { ProcessRunResult } from 'claude-code'

type Comment = { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }

type Repo = {
  owner: string
  name: string
  description: string
  topics: string[]
  collaborators: Set<string>
  files: Record<string, string>
  labels: Set<string>
  issues: number
  comments: Comment[]
  ignored: Set<string>
}

type Invitation = { id: number; to: string; repo: string }

export type Call = { as: string; method: string; path: string; headers: string[]; body?: unknown }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function fromBase64Utf8(b64: string): string {
  const bytes: number[] = []
  const clean = b64.replace(/=+$/, '')
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, B64.indexOf(clean[i + k] ?? 'A')), 0)
    bytes.push((n >> 16) & 255)
    if (clean[i + 2] !== undefined) bytes.push((n >> 8) & 255)
    if (clean[i + 3] !== undefined) bytes.push(n & 255)
  }
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!
    const len = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4
    let cp = len === 1 ? b : b & (0xff >> (len + 1))
    for (let k = 1; k < len; k++) cp = (cp << 6) | (bytes[i + k]! & 63)
    out += String.fromCodePoint(cp)
    i += len
  }
  return out
}

const result = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const REASON: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  304: 'Not Modified',
  404: 'Not Found',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
}

export class FakeGitHub {
  as = 'alice'
  repos = new Map<string, Repo>()
  invitations: Invitation[] = []
  calls: Call[] = []
  // Paths (substring match) answered with this status instead, for error cases.
  failing: Record<string, number> = {}
  private ids = 1000
  private seconds = 0

  // ISO times one second apart, so `since` filters behave like GitHub's.
  private stamp() {
    return new Date(Date.UTC(2026, 9, 17, 12, 0, this.seconds++)).toISOString().replace('.000', '')
  }

  private respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
    const text = body === undefined ? '' : JSON.stringify(body)
    const head = [`HTTP/2.0 ${status} ${REASON[status] ?? ''}`, 'Content-Type: application/json; charset=utf-8']
    for (const [k, v] of Object.entries(headers)) head.push(`${k}: ${v}`)
    const stdout = `${head.join('\r\n')}\r\n\r\n${status >= 400 && !text ? '{"message":"error"}' : text}`
    return result(status >= 300 ? 1 : 0, stdout, status >= 300 ? `gh: (HTTP ${status})\n` : '')
  }

  private canSee(r: Repo) {
    return r.owner === this.as || r.collaborators.has(this.as)
  }

  repoJson(id: string, r: Repo) {
    return { name: r.name, full_name: id, owner: { login: r.owner }, private: true, description: r.description, topics: r.topics }
  }

  // Seeds a repo that is not a chat, or a chat made outside the mod.
  addRepo(id: string, init: Partial<Omit<Repo, 'owner' | 'name'>> = {}) {
    const [owner = '', name = ''] = id.split('/')
    this.repos.set(id, {
      owner,
      name,
      description: '',
      topics: [],
      collaborators: new Set(),
      files: {},
      labels: new Set(),
      issues: 0,
      comments: [],
      ignored: new Set(),
      ...init,
    })
  }

  // The engine's `process.run`: only `gh api` is faked.
  run(argv: readonly string[], stdin?: string): ProcessRunResult {
    const [bin = '', cmd, ...rest] = argv
    if (!/(^|\/)gh$/.test(bin) || cmd !== 'api') return result(1, '', 'fake: not faked')
    let method = 'GET'
    const headers: string[] = []
    let path = ''
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!
      if (a === '--include') continue
      else if (a === '--method') method = rest[++i]!
      else if (a === '-H') headers.push(rest[++i]!)
      else if (a === '--input') i++
      else path = a.replace(/^\//, '')
    }
    const body = stdin ? (JSON.parse(stdin) as Record<string, unknown>) : undefined
    this.calls.push({ as: this.as, method, path, headers, ...(body ? { body } : {}) })
    const failing = Object.entries(this.failing).find(([p]) => path.includes(p))
    if (failing) return this.respond(failing[1])
    return this.route(method, path, headers, body ?? {})
  }

  private route(method: string, full: string, headers: string[], body: Record<string, unknown>): ProcessRunResult {
    const [path = '', query = ''] = full.split('?')
    const q = new URLSearchParams(query)
    const page = Number(q.get('page') ?? 1)
    const perPage = Number(q.get('per_page') ?? 30)
    const paged = <T>(list: T[]) => list.slice((page - 1) * perPage, page * perPage)
    const withEtag = (list: unknown[]) => {
      const etag = `W/"${list.length}-${JSON.stringify(list).length}"`
      if (headers.some(h => h === `If-None-Match: ${etag}`)) return this.respond(304, undefined, { Etag: etag })
      return this.respond(200, list, { Etag: etag })
    }

    if (method === 'GET' && path === 'user/repos') {
      const mine = [...this.repos].filter(([, r]) => this.canSee(r)).sort(([a], [b]) => a.localeCompare(b))
      return withEtag(paged(mine.map(([id, r]) => this.repoJson(id, r))))
    }
    if (method === 'POST' && path === 'user/repos') {
      const id = `${this.as}/${String(body.name)}`
      if (this.repos.has(id)) return this.respond(422, { message: 'Repository creation failed.' })
      this.addRepo(id, { description: String(body.description ?? '') })
      return this.respond(201, this.repoJson(id, this.repos.get(id)!))
    }
    if (method === 'GET' && path === 'user/repository_invitations') {
      return this.respond(
        200,
        this.invitations
          .filter(i => i.to === this.as)
          .map(i => ({ id: i.id, repository: this.repoJson(i.repo, this.repos.get(i.repo)!) })),
      )
    }
    const inv = /^user\/repository_invitations\/(\d+)$/.exec(path)
    if (inv && method === 'PATCH') {
      const found = this.invitations.find(i => i.id === Number(inv[1]) && i.to === this.as)
      if (!found) return this.respond(404)
      this.invitations = this.invitations.filter(i => i !== found)
      this.repos.get(found.repo)?.collaborators.add(this.as)
      return this.respond(204)
    }

    const m = /^repos\/([^/]+\/[^/]+)\/(.+)$/.exec(path)
    const repo = m ? this.repos.get(m[1]!) : undefined
    if (!m || !repo || !this.canSee(repo)) return this.respond(404, { message: 'Not Found' })
    const [, id = '', rest = ''] = m

    if (method === 'PUT' && rest === 'topics') {
      repo.topics = (body.names as string[]) ?? []
      return this.respond(200, { names: repo.topics })
    }
    if (rest.startsWith('contents/')) {
      const file = rest.slice('contents/'.length)
      if (method === 'PUT') {
        repo.files[file] = fromBase64Utf8(String(body.content))
        return this.respond(201, { content: { path: file } })
      }
      if (method === 'GET') {
        const text = repo.files[file]
        if (text === undefined) return this.respond(404, { message: 'Not Found' })
        // With the raw media type GitHub answers the file itself.
        return result(0, `HTTP/2.0 200 OK\r\nContent-Type: application/vnd.github.raw+json\r\n\r\n${text}`)
      }
    }
    if (method === 'POST' && rest === 'labels') {
      if (repo.labels.has(String(body.name))) return this.respond(422, { message: 'Validation Failed' })
      repo.labels.add(String(body.name))
      return this.respond(201, { name: body.name })
    }
    if (method === 'POST' && rest === 'issues') {
      repo.issues++
      return this.respond(201, { number: repo.issues, title: body.title })
    }
    if (method === 'PUT' && rest === 'subscription') {
      repo.ignored.add(this.as)
      return this.respond(200, { ignored: true })
    }
    if (method === 'GET' && rest === 'collaborators') {
      return this.respond(200, [repo.owner, ...repo.collaborators].map(login => ({ login })))
    }
    const collab = /^collaborators\/([^/]+)$/.exec(rest)
    if (collab && method === 'PUT') {
      const login = collab[1]!
      if (repo.owner !== this.as) return this.respond(404)
      this.invitations.push({ id: this.ids++, to: login, repo: id })
      return this.respond(201, { id: this.ids })
    }
    if (collab && method === 'DELETE') {
      repo.collaborators.delete(collab[1]!)
      return this.respond(204)
    }
    if (rest === `issues/1/comments`) {
      if (repo.issues < 1) return this.respond(404, { message: 'Not Found' })
      if (method === 'POST') {
        const at = this.stamp()
        const c: Comment = { id: this.ids++, body: String(body.body), user: { login: this.as }, created_at: at, updated_at: at }
        repo.comments.push(c)
        return this.respond(201, c)
      }
      const since = q.get('since')
      return withEtag(paged(repo.comments.filter(c => !since || c.updated_at >= since)))
    }
    return this.respond(404, { message: 'Not Found' })
  }
}
