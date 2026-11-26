# orchestration

A Claude Code plugin that sizes each task and picks one of three routes: a plain session, a plain session plus a fresh reviewer, or the orchestrator. On the orchestrate route a task is split into slices: workers build them, fresh reviewers check each one, and gates hold the result back until the tests and the reviews pass.

## When to use it

Use it when a wrong result is costly, or when a task splits into parts that can run side by side. It takes code, research, writing, analysis and operations.

A small task needs none of this: the plugin's triage sends it to a plain session.

## Install

Add the marketplace once, then install the plugin:

```bash
claude plugin marketplace add 0xcvaliente/claude-code-orchestration
claude plugin install orchestration@claude-code-orchestration
```

A plugin installed or updated from your shell loads in the next session you start. In a session that is already open, run `/reload-plugins`.

A plugin cannot set two settings this one needs: `worktree.baseRef` set to `"head"`, and the permission denies. Add them yourself, as the [README](https://github.com/0xcvaliente/claude-code-orchestration#readme) shows under Install.

## First command

In a Claude Code chat, type `/route` followed by your task. It replies with the route it picked and why, then runs it. `/orchestration on` opens a live pane beside the chat.

## Documentation

- [README](https://github.com/0xcvaliente/claude-code-orchestration#readme): install, the two settings, the first run.
- [Sharing the plugin](https://github.com/0xcvaliente/claude-code-orchestration/blob/main/docs/marketplace.md): updates, release tags and what the plugin ships.
- [Documentation index](https://github.com/0xcvaliente/claude-code-orchestration/blob/main/docs/README.md): every page, with what it is for.
- [CHANGELOG](https://github.com/0xcvaliente/claude-code-orchestration/blob/main/CHANGELOG.md): what changed in each release.

## License

MIT. The text is in the [LICENSE](https://github.com/0xcvaliente/claude-code-orchestration/blob/main/LICENSE) file, which ships beside this README.
