# omp-quick-commit

One-key commit & push for [oh-my-pi](https://github.com/can1357/oh-my-pi) (the `omp` coding agent).

Type **/commit** or press **Alt+C** to run `omp commit --push` with the configured commit role, then echo the new commit(s) into the session. Type **/quick-commit** — or press **Alt+Q** — to skip the diff pipeline and summarize the message from the agent's own session context instead.

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

While `omp commit --push` runs, a footer status line shows progress and is cleared when the run ends. On success, a follow-up message lists the new commits (`hash` + subject). Failures and “no new commit” cases show a notification instead.

### /quick-commit

No diff pipeline and no changelog updates: the message comes from what the agent just did.

1. Stages everything (`git add -A`) and stops with a notification when nothing is staged.
2. Reads the last 12 messages of the current branch (user requests + agent replies, plus the paths the agent edited) and asks the commit role (`@commit`, falling back to `@smol` then the session model) for one conventional-commit message. The description follows the conversation's language; the type prefix stays English.
3. Runs `git commit -m <message>`, then `git push` — falling back to `git push --set-upstream origin HEAD` when the branch has no upstream.

It does nothing (with a notification) when the agent is busy, when the session has no agent context yet (use `/commit`), or when the working tree is already clean.

Both Alt shortcuts require the terminal to report Alt as Meta. On macOS that means enabling "Use Option as Meta key" in Terminal.app (or Option → `Esc+` in iTerm2); otherwise Option+Q types `œ` and the shortcut never fires.

Requires `git` and `omp` on `PATH`. Uses the workspace cwd.

## License

[MIT](./LICENSE)
