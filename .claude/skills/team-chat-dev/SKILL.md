---
name: team-chat-dev
description: How to load, type-check, validate and test the Claude Team Chat mod (the `mod/` folder) on this Mac. Use before and after changing anything under `mod/`, and when the mod does not load or a check fails.
---

# Developing the Team Chat mod

The mod is `mod/`, a Claude Code plugin of function hooks (`.claude-plugin/plugin.json`, `hooks/hooks.json` → `hooks/register.tsx`).

## The `claude` binary

On this Mac `claude` is not on the PATH. Use the CLI bundled with the desktop app:

```bash
CLAUDE="$(ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude | tail -1)"
```

## Load it

- Interactive session with the mod: `"$CLAUDE" --plugin-dir mod`, then `/chat`.
- In the desktop app, load the `plugin-authoring` skill, which offers hot reloading of the mods folder; or point `CLAUDE_CODE_PLUGIN_DIRS` at `mod`.
- The engine writes the API types to `mod/.claude-plugin/types/` the first time it loads the mod from this folder (git-ignored). `mod/tsconfig.json` extends them, so `tsc` needs one load first.

## Check it

Run all three after every change, from the project root:

```bash
"$CLAUDE" plugin validate mod
"$CLAUDE" plugin test mod
npx -y -p typescript@5.6.3 tsc -p mod
```

- `plugin validate` must end with `✔ Validation passed` (the "no author" warning is fine).
- Write a `*.test.tsx` for each behaviour. Mount the pane with full `Pane` props:
  - `title`, `isFocused`, `bodyColumns`, `placement`, `scroll: { offset, bodyRows }`, `view: {}`.
- Run one `test()` per surface (`terminal`, `desktop`), because state carries across mounts inside one test.

## Gotchas found so far

- `$.state` survives a reload; a value written in an older format comes back. Give the atom a new `shape` when its type changes.
- The state contract (`types/index.d.ts`) must not `import`; `Shaped` is in scope inside `declare module 'claude-code'`.
- `Input` does not exist on `mobile`; read it as `'Input' in els ? els.Input : undefined`.
- Size the pane body to `e.props.scroll.bodyRows` and `e.props.bodyColumns`, not the viewport.
- `gh` may not be on the session PATH; on this Mac it is `~/.local/bin/gh`.
