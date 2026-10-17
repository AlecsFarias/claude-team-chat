import { expect, test } from 'claude-code/testing'

import type { ChatUser } from '../types'
import {
  avatarAt64,
  checkGh,
  fetchAvatar,
  findGh,
  ghApi,
  ghCandidates,
  getUser,
  homeDir,
  isGhError,
  parseAuthStatus,
} from './github'
import type { Run } from './github'

const HOME = '/Users/octocat'
const LOCAL_GH = `${HOME}/.local/bin/gh`

type Reply = { exitCode?: number; stdout?: string; stderr?: string } | 'reject'

// A fake runner: argv joined by spaces → canned reply; anything unlisted cannot start.
function fake(replies: Record<string, Reply>) {
  const calls: { argv: string; stdin?: string }[] = []
  const run: Run = async (argv, init) => {
    const key = argv.join(' ')
    calls.push({ argv: key, stdin: init?.stdin })
    const reply = replies[key]
    if (!reply || reply === 'reject') throw new Error(`spawn ${argv[0]} ENOENT`)
    return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return { run, calls }
}

const VERSION = { stdout: 'gh version 2.102.0 (2026-09-30)\nhttps://github.com/cli/cli/releases/tag/v2.102.0\n' }

// Real `gh auth status -h github.com` text (gh 2.102), account renamed.
const AUTH_OK = {
  stdout: [
    'github.com',
    '  ✓ Logged in to github.com account octocat (keyring)',
    '  - Active account: true',
    '  - Git operations protocol: https',
    '  - Token: gho_************************************',
    "  - Token scopes: 'delete_repo', 'gist', 'read:org', 'repo', 'workflow'",
    '',
  ].join('\n'),
}
const AUTH_NO_REPO = { stdout: AUTH_OK.stdout.replace("'repo', ", '') }
const AUTH_FINE_GRAINED = { stdout: AUTH_OK.stdout.replace(/.*Token scopes.*\n/, '') }
const AUTH_OUT = {
  exitCode: 1,
  stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
}

const included = (status: string, headers: string[], body = '') =>
  `HTTP/2.0 ${status}\r\n${headers.join('\r\n')}\r\n\r\n${body}`

const USER_OK = {
  stdout: included(
    '200 OK',
    ['Content-Type: application/json; charset=utf-8', 'Etag: W/"abc123"'],
    JSON.stringify({
      login: 'octocat',
      name: 'The Octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
      html_url: 'https://github.com/octocat',
      type: 'User',
    }),
  ),
}

const ghAt = (gh: string, more: Record<string, Reply>) => ({ [`${gh} --version`]: VERSION, ...more })

test('candidates and home folder', async () => {
  expect(ghCandidates(HOME)).toEqual(['gh', LOCAL_GH, '/opt/homebrew/bin/gh', '/usr/local/bin/gh'])
  expect(ghCandidates('')).toEqual(['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'])
  expect(await homeDir(fake({ '/bin/sh -c printf %s "$HOME"': { stdout: HOME } }).run)).toBe(HOME)
  expect(await homeDir(fake({}).run)).toBe('')
})

test('gh missing from every candidate', async () => {
  const { run, calls } = fake({})
  expect(await findGh(run, HOME)).toBeNull()
  expect(calls.map(c => c.argv)).toEqual(ghCandidates(HOME).map(gh => `${gh} --version`))
  expect(await checkGh(run, HOME)).toEqual({ status: 'missing' })
})

test('gh found only at ~/.local/bin', async () => {
  const { run } = fake({ 'gh --version': { exitCode: 127 }, ...ghAt(LOCAL_GH, {}) })
  expect(await findGh(run, HOME)).toBe(LOCAL_GH)
})

test('logged out', async () => {
  const { run } = fake(ghAt('gh', { 'gh auth status -h github.com': AUTH_OUT }))
  expect(await checkGh(run, HOME)).toEqual({ status: 'logged-out', gh: 'gh' })
  // A token gh says is invalid also means signing in again.
  const failed = '  X Failed to log in to github.com account octocat (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n'
  expect(parseAuthStatus(failed)).toEqual({ state: 'logged-out' })
})

test('missing repo scope', async () => {
  const { run, calls } = fake(ghAt('gh', { 'gh auth status -h github.com': AUTH_NO_REPO }))
  expect(await checkGh(run, HOME)).toEqual({ status: 'no-repo-scope', gh: 'gh', login: 'octocat' })
  expect(calls.some(c => c.argv.includes(' api '))).toBe(false)
})

test('ok with profile; no scopes line counts as fine', async () => {
  for (const auth of [AUTH_OK, AUTH_FINE_GRAINED]) {
    const { run } = fake(ghAt(LOCAL_GH, { [`${LOCAL_GH} auth status -h github.com`]: auth, [`${LOCAL_GH} api --include user`]: USER_OK }))
    expect(await checkGh(run, HOME)).toEqual({
      status: 'ok',
      gh: LOCAL_GH,
      profile: {
        id: 'octocat',
        handle: 'octocat',
        name: 'The Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
        htmlUrl: 'https://github.com/octocat',
      },
    })
  }
})

test('several accounts: the active one counts', () => {
  const text = [
    'github.com',
    '  ✓ Logged in to github.com account other (keyring)',
    '  - Active account: false',
    "  - Token scopes: 'gist'",
    '  ✓ Logged in to github.com account octocat (keyring)',
    '  - Active account: true',
    "  - Token scopes: 'repo'",
  ].join('\n')
  expect(parseAuthStatus(text)).toEqual({ state: 'logged-in', login: 'octocat', scopes: ['repo'] })
})

test('api network error', async () => {
  const stderr = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n'
  const down = fake(ghAt('gh', {
    'gh auth status -h github.com': AUTH_OK,
    'gh api --include user': { exitCode: 1, stderr: `Get "https://api.github.com/user": dial tcp: lookup api.github.com: no such host\n${stderr}` },
  }))
  const state = await checkGh(down.run, HOME)
  expect(state).toMatchObject({ status: 'error', gh: 'gh' })
  expect(state.status === 'error' && state.message).toMatch(/Sem conexão/)
  // A run that cannot finish (timeout) is a network error too.
  const hung = await ghApi(fake({ 'gh api --include user': 'reject' }).run, 'gh', 'user')
  expect(hung).toMatchObject({ ok: false, error: { kind: 'network' } })
})

test('rate limit 403', async () => {
  const { run } = fake({
    'gh api --include users/octocat': {
      exitCode: 1,
      stdout: included(
        '403 Forbidden',
        ['X-Ratelimit-Limit: 5000', 'X-Ratelimit-Remaining: 0', `X-Ratelimit-Reset: ${Math.floor(Date.now() / 1000) + 600}`],
        '{"message":"API rate limit exceeded for user ID 1.","documentation_url":"https://docs.github.com/rest"}',
      ),
      stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n',
    },
  })
  const res = await ghApi(run, 'gh', 'users/octocat')
  expect(res).toMatchObject({ ok: false, status: 403, error: { kind: 'rate-limited' } })
  expect(!res.ok && res.error.message).toMatch(/Limite de uso.*10 min/)
})

test('getUser 404 and success', async () => {
  const { run } = fake({
    'gh api --include users/nobody-here': {
      exitCode: 1,
      stdout: included('404 Not Found', ['Content-Type: application/json'], '{"message":"Not Found","status":"404"}'),
      stderr: 'gh: Not Found (HTTP 404)\n',
    },
    'gh api --include users/octocat': USER_OK,
  })
  expect(await getUser(run, 'gh', 'nobody-here')).toEqual({ kind: 'not-found', message: '@nobody-here não existe no GitHub.' })
  const user = await getUser(run, 'gh', '@octocat')
  expect(isGhError(user)).toBe(false)
  expect(user as ChatUser).toEqual({
    id: 'octocat',
    handle: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  })
})

test('invalid login rejected without running', async () => {
  const { run, calls } = fake({})
  for (const bad of ['', 'a b', '-octo', 'octo-', 'oc--to', '../etc', 'x'.repeat(40), 'octo;rm']) {
    const res = await getUser(run, 'gh', bad)
    expect(isGhError(res) && res.kind).toBe('not-found')
    expect(await fetchAvatar(run, 'https://avatars.githubusercontent.com/u/1', bad, '/tmp/cache')).toBeNull()
  }
  expect(calls).toHaveLength(0)
})

test('ghApi 304 with ETag, headers and JSON body on stdin', async () => {
  const { run, calls } = fake({
    'gh api --include -H If-None-Match: W/"abc123" repos/o/r/issues/1/comments': {
      exitCode: 1,
      stdout: included('304 Not Modified', ['Etag: W/"abc123"', 'X-Ratelimit-Remaining: 4999']),
      stderr: 'gh: HTTP 304\n',
    },
    'gh api --include --method POST --input - repos/o/r/issues/1/comments': {
      stdout: included('201 Created', ['Etag: "def"'], '{"id":7}'),
    },
  })
  expect(await ghApi(run, 'gh', 'repos/o/r/issues/1/comments', { headers: { 'If-None-Match': 'W/"abc123"' } })).toEqual({
    ok: true,
    data: undefined,
    status: 304,
    etag: 'W/"abc123"',
  })
  const made = await ghApi<{ id: number }>(run, 'gh', 'repos/o/r/issues/1/comments', { method: 'post', body: { body: 'oi' } })
  expect(made).toEqual({ ok: true, data: { id: 7 }, status: 201, etag: '"def"' })
  expect(calls[1]?.stdin).toBe('{"body":"oi"}')
})

const CACHE = '/tmp/cache'
const AVATAR = 'https://avatars.githubusercontent.com/u/583231?v=4'
const CURL = `/usr/bin/curl -fsSL --max-time 15 -o ${CACHE}/octocat.download ${AVATAR}&s=64`
const PNG_HEX = { stdout: '           89  50  4e  47  0d  0a  1a  0a\n' }
const JPEG_HEX = { stdout: '           ff  d8  ff  e0  00  10  4a  46\n' }
const base = {
  [`/bin/mkdir -p ${CACHE}`]: {},
  [CURL]: {},
  [`/bin/rm -f ${CACHE}/octocat.download`]: {},
}

test('avatar size param', () => {
  expect(avatarAt64(AVATAR)).toBe(`${AVATAR}&s=64`)
  expect(avatarAt64('https://avatars.githubusercontent.com/u/1')).toBe('https://avatars.githubusercontent.com/u/1?s=64')
  expect(avatarAt64('https://avatars.githubusercontent.com/u/1?s=460&v=4')).toBe('https://avatars.githubusercontent.com/u/1?s=64&v=4')
})

test('fetchAvatar already PNG', async () => {
  const { run, calls } = fake({
    ...base,
    [`/usr/bin/od -An -tx1 -N8 ${CACHE}/octocat.download`]: PNG_HEX,
    [`/bin/mv -f ${CACHE}/octocat.download ${CACHE}/octocat.png`]: {},
  })
  expect(await fetchAvatar(run, AVATAR, 'Octocat', CACHE)).toBe(`${CACHE}/octocat.png`)
  expect(calls.some(c => c.argv.startsWith('/usr/bin/sips'))).toBe(false)
})

test('fetchAvatar JPEG converted with sips', async () => {
  const sips = `/usr/bin/sips -s format png ${CACHE}/octocat.download --out ${CACHE}/octocat.png`
  const { run, calls } = fake({
    ...base,
    [`/usr/bin/od -An -tx1 -N8 ${CACHE}/octocat.download`]: JPEG_HEX,
    [sips]: {},
    [`/usr/bin/od -An -tx1 -N8 ${CACHE}/octocat.png`]: PNG_HEX,
  })
  expect(await fetchAvatar(run, AVATAR, 'octocat', CACHE)).toBe(`${CACHE}/octocat.png`)
  expect(calls.map(c => c.argv)).toContain(sips)

  // No sips on this machine: no PNG, so no picture.
  const nosips = fake({ ...base, [`/usr/bin/od -An -tx1 -N8 ${CACHE}/octocat.download`]: JPEG_HEX })
  expect(await fetchAvatar(nosips.run, AVATAR, 'octocat', CACHE)).toBeNull()
  // Download failed.
  const offline = fake({ ...base, [CURL]: { exitCode: 6 } })
  expect(await fetchAvatar(offline.run, AVATAR, 'octocat', CACHE)).toBeNull()
})
