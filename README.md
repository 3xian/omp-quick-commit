# omp-quick-commit

One-key commit & push for [OMP](https://github.com/can1357/oh-my-pi).

Press **Alt+C** to run `omp commit --push` with the configured commit role, then echo the new commit(s) into the session.

## Install

```sh
omp plugin install git:github.com/3xian/omp-quick-commit
```

Or copy into user extensions and restart OMP:

```sh
cp -r . ~/.omp/agent/extensions/omp-quick-commit
```

## Usage

| Shortcut | Action |
| --- | --- |
| `Alt+C` | Commit all changes and push |

On success, a message lists the new commits (`hash` + subject). Failures and “no new commit” cases show a notification instead.

Requires `git` and `omp` on `PATH`. Uses the workspace cwd.

## License

[MIT](./LICENSE)
