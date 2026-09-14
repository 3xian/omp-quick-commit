# omp-quick-commit

One-key commit & push for [oh-my-pi](https://github.com/can1357/oh-my-pi) (the `omp` coding agent).

Type **/commit** or press **Alt+C** to run `omp commit --push` with the configured commit role, then echo the new commit(s) into the session. Type **/quick-commit**, or press **Alt+Q**, to skip the diff pipeline and summarize the message from the agent's own session context instead.

## Why this exists

Committing from inside a coding agent usually means leaving the agent: switch to a terminal, `git add -A`, hand-write a message that reconstructs intent the agent already had, `git commit`, `git push`. `omp commit --push` removes the typing, but it still runs the full commit pipeline (diff analysis, changelog updates, message generation) on every invocation.

Most of that work is redundant. The agent's own session already recorded what was asked for and what changed, and a commit message is just that record, compressed. This extension hands that record to the commit step instead of rebuilding it from the diff:

- **Commit from where the work happened.** `/commit` or `Alt+C` on the session that did the work, with no context switch, no terminal, no message to compose.
- **Two cost tiers behind the same shortcut.** `/commit` keeps the rigor and shells out to the official `omp commit --push` pipeline. `/quick-commit` (or `Alt+Q`) skips the diff pipeline and changelog updates: it stages the tree, summarizes the last 12 messages of the current branch, and commits from one cheap-model call over that context.
- **No second configuration surface.** The quick path resolves the same `@commit` role the official pipeline uses (falling back to `@smol`, then the session model) and picks up its API key from the model registry. Whatever you configured for `omp commit` also drives `/quick-commit`.
- **The message reflects intent, not just the diff.** The quick path summarizes the user requests, agent replies, and the paths the agent edited (tool output stripped out), and is instructed to describe only what that log supports. Output is conventional commits: the type prefix is always English, the description follows the conversation's language.
- **The session stays in sync.** The new commit(s) (`hash` plus subject) are echoed back into the transcript, so agent and user share one view of what landed.

Neither path touches your history beyond `git add -A`, `git commit`, and `git push`. When the tree is clean, the agent is busy, or there is no session context yet, it stops with a notification.

## Install

```sh
omp plugin install git:github.com/3xian/omp-quick-commit
```

Restart OMP after install. `/commit` and `/quick-commit` are slash commands, not shell binaries.

Or copy into user extensions and restart OMP:

```sh
cp -r . ~/.omp/agent/extensions/omp-quick-commit
```

## Usage

| Command / Shortcut | Action |
| --- | --- |
| `/commit` | Commit all changes and push (`omp commit --push`) |
| `/quick-commit` | Commit all changes and push, with the message summarized from agent context |
| `Alt+C` | Same as `/commit` |
| `Alt+Q` | Same as `/quick-commit` |

In the TUI, a spinner row above the editor reports progress with the same shimmer sweep as omp's built-in working indicator. It honors the `display.shimmer` setting; non-TUI modes keep their supported status output. On success, a follow-up message lists the new commits (`hash` + subject). Failures and “no new commit” cases show a notification instead.

### /quick-commit

No diff pipeline and no changelog updates: the message comes from what the agent just did.

1. Checks `git status --porcelain` and stops before the model call when the tree is clean.
2. Stages everything while the commit role summarizes a bounded recent context in parallel. The role resolves as `@commit`, falling back to `@smol` then the session model; the description follows the conversation's language and the type prefix stays English.
3. Verifies that staging produced a diff, snapshots `HEAD`, commits, then resolves the current upstream before reading the new commit log while pushing. A branch without an upstream uses `git push --set-upstream origin HEAD`.

It does nothing (with a notification) when the agent is busy, another commit is already running, the session has no agent context yet (use `/commit`), or the working tree is already clean.

Both Alt shortcuts require the terminal to report Alt as Meta. On macOS that means enabling "Use Option as Meta key" in Terminal.app (or `Esc+` in iTerm2), otherwise Option+Q types `œ` and the shortcut never fires.

Requires `git` and `omp` on `PATH`. Uses the workspace cwd.

## License

[MIT](./LICENSE)
