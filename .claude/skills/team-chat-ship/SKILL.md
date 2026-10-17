---
name: team-chat-ship
description: How to land a change in the Claude Team Chat repo - branch, checks, commit, PR and merge. Use before committing, pushing or opening a PR.
---

# Shipping a change in Claude Team Chat

One git repo at the project root, default branch `main`, public on GitHub as `AlecsFarias/claude-team-chat` (open source): everything committed is visible to anyone.

1. **Sync first:** `git fetch && git switch main && git pull --ff-only` (once a remote exists).
2. **Branch** with an English name: `feat/<short-topic>`, `fix/<short-topic>`, `docs/<short-topic>`.
3. **Check** with the `team-chat-dev` skill: validate, test and `tsc` all pass.
4. **Commit** with a conventional prefix and an English message, for example `feat: poll chat comments with ETag`.
   - No AI attribution: no `Co-Authored-By`, no "Generated with", no mention of Claude.
   - Never stage `mod/.claude-plugin/types/` (generated) or anything holding a token.
5. **PR**: `gh pr create` with an English title and body that say what changed and how it was checked.
6. **Merge** only when the user says so. Pushing to `main` or merging is not implied by "commit".
