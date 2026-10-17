# Claude Team Chat

A [Claude Code](https://claude.com/claude-code) mod for **joint sessions**: when several people are working with Claude at the same time, a chat pane becomes the channel between each person's Claude.

- **Share context.** Send a summary of your session, Claude's last answer or your changed files to a group. A teammate brings it into their own Claude with one click, so nobody has to copy and paste.
- **Claude in the chat.** Claude can read a group and draft posts for you. Nothing is posted until you press Post.
- **Hand off tasks.** Send a task with its context to someone, who starts it in their Claude.
- Plus the basics: groups, direct chats, files (up to 4 MB) and links, and a list of a chat's files, links and contexts.

> **Status:** early prototype. Sign-in with GitHub, groups, direct chats and text messages work over GitHub; files and the joint-session features are not built yet. See the [MVP spec](docs/MVP.md) (in Portuguese) for the plan.

## How it works

There is no server. GitHub is the backend, used through your own [GitHub CLI](https://cli.github.com/):

- Your identity is your GitHub profile.
- Each chat is a private repository, and its members are collaborators.
- Messages are comments on an issue in that repository.
- Files are committed to the repository.

The mod polls for new messages: every 20 s for the open chat, every 5 min for the others.

## Requirements

- Claude Code, in the terminal or the desktop app. The mobile app is not supported.
- `gh` installed and signed in (`gh auth status`) with the `repo` scope.

## Install

In Claude Code (terminal or desktop app):

```
/plugin install team-chat --marketplace AlecsFarias/claude-team-chat
```

On versions older than 2.1.275, add the marketplace first:

```
/plugin marketplace add AlecsFarias/claude-team-chat
/plugin install team-chat@claude-team-chat
```

Then run `/chat`, check that the GitHub account shown is yours and press "Começar". Invitations to chats are accepted on their own within 5 minutes.

## Development

The mod lives in [`mod/`](mod/). It is a Claude Code plugin of function hooks:

- `hooks/register.tsx`: state, actions and the `/chat` command.
- `hooks/views.tsx`: the screens.
- `hooks/github.ts`: finding `gh`, the sign-in check and `gh api` calls.
- `hooks/chats.ts`: chats, messages, members and invitations on GitHub.
- `hooks/sync.ts`: polling and the actions that write.
- `types/index.d.ts`: the state contract.

Load it in a session and open the pane:

```bash
claude --plugin-dir mod
```

Then run `/chat`.

Check it:

```bash
claude plugin validate mod
claude plugin test mod
npx -y -p typescript@5.6.3 tsc -p mod
```

`tsc` needs the API types that Claude Code writes to `mod/.claude-plugin/types/` the first time it loads the mod.

## License

[MIT](LICENSE)
