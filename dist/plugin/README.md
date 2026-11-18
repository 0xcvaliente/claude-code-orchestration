# orchestration

A Claude Code plugin that sizes each task and runs it the cheapest way that still checks the result. A small task runs as a plain session. A large or risky task is split into slices: workers build them, fresh reviewers check each one, and gates hold back the result until the tests and the reviews pass.

## When to use it

Use it when a wrong result is costly, or when a task splits into parts that can run side by side. It takes code, research, writing, analysis and operations. For a small task a plain session is cheaper, and the plugin's triage sends such work to one.

## Install

Add the marketplace once, then install the plugin:

```bash
claude plugin marketplace add 0xcvaliente/claude-code-orchestration
claude plugin install orchestration@claude-code-orchestration
```

A plugin installed or updated from your shell loads in the next session you start. In a session that is already open, run `/reload-plugins`.

## First command

In a Claude Code chat, type `/route` followed by your task. It replies with the route it picked and why, then runs it. `/orchestration on` opens a live pane beside the chat.

## Documentation

- [README](https://github.com/0xcvaliente/claude-code-orchestration#readme): install, the two settings a plugin cannot set, and the first run.
- [Sharing the plugin](https://github.com/0xcvaliente/claude-code-orchestration/blob/main/docs/marketplace.md): updates, release tags and what the plugin ships.
- [Documentation index](https://github.com/0xcvaliente/claude-code-orchestration/blob/main/docs/README.md): every page, with the question it answers.

## License

MIT. The text is in the [LICENSE](https://github.com/0xcvaliente/claude-code-orchestration/blob/main/LICENSE) file, which ships beside this README.
