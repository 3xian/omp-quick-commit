# omp-quick-commit

One-key commit & push for [OMP](https://github.com/can1357/oh-my-pi).

Type **/commit** or press **Alt+C** to run `omp commit --push` with the configured commit role, then echo the new commit(s) into the session.

## Install

```sh
omp plugin install git:github.com/3xian/omp-quick-commit
```

Restart OMP after install. `/commit` is a slash command, not a shell binary.

Or copy into user extensions and restart OMP:

```sh
cp -r . ~/.omp/agent/extensions/omp-quick-commit
```

## Usage

| Command / Shortcut | Action |
| --- | --- |
| `/commit` | Commit all changes and push |
| `Alt+C` | Same as `/commit` |

While `omp commit --push` runs, a footer status line shows progress and is cleared when the run ends. On success, a follow-up message lists the new commits (`hash` + subject). Failures and “no new commit” cases show a notification instead.

Requires `git` and `omp` on `PATH`. Uses the workspace cwd.

## License

[MIT](./LICENSE)
