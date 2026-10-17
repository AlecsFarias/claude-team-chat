# Claude Team Chat

A Claude Code mod for a joint session between people who use Claude at the same time: a chat pane that is the channel between each person's Claude (share session context, let Claude read and post to the chat with approval, hand off tasks with context). Owner: Alecs (GitHub `AlecsFarias`). Talk to the user in Brazilian Portuguese.

## Where things are

| Path | What it is |
| --- | --- |
| `docs/MVP.md` | The MVP spec: goal, principles, GitHub-as-backend design, screens with acceptance criteria, out of scope, phases, risks. Read it before any feature work. |
| `mod/` | The mod (Claude Code plugin of function hooks): `hooks/register.tsx` (state, actions, `/chat`), `hooks/views.tsx` (screens), `hooks/mock.ts` (sample data to replace), `types/index.d.ts` (`$.state` contract), `hooks/*.test.tsx`. |
| Design canvas | https://claude.ai/artifact/EJobVufCKs7JAvR63J6GmL (12 screens; section 7 of the MVP lists the tweaks still owed for GitHub identity). |

## Current state

UI prototype only, with sample data and no real connection. Next is phase 2 of `docs/MVP.md`: locate `gh`, "Entrar com GitHub", and a `github.ts` layer.

## Rules

- No server of our own in the MVP: GitHub is the backend, reached only through `$.process.run` with the user's `gh` (`gh api ...`). Never read, print or store the GitHub token.
- Nothing from a session leaves without a preview the person confirms; Claude never posts to a chat without the person pressing Post.
- The mod runs with no DOM and no Node: everything outside goes through `$`. Draw with the elements from `$.ui.resolve(e)`; keep drawn state in `$.state` (declare every key in `types/index.d.ts`; bump an atom's `shape` when a value's format changes) and cross-session data in `$.store`.
- Files are capped at 4 MiB (`$.fs.read`); `$.fs.write` writes text only.
- Every change keeps `plugin validate`, `plugin test` and `tsc` green (see the `team-chat-dev` skill).
- Git artifacts (commit messages, PR titles and bodies, branch names) in English. No AI attribution anywhere: no `Co-Authored-By`, no "Generated with", no mention of Claude.
- The repository is public and open source (https://github.com/AlecsFarias/claude-team-chat): never commit tokens, personal data, machine-specific paths or anything from a real chat.

## Skills

- `team-chat-dev`: load the mod, type-check, validate and test it on this Mac.
- `team-chat-ship`: branch, commit, PR and merge flow.
