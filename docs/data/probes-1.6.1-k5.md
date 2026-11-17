# Probes for 1.6.1, slice k5 (2026-11-17, Claude Code 2.1.326)

No paid model call was made. Total cost: 0 USD.

## Probe 1: the startup warning on the headless `git -C` allow rules

Command, run in the worktree, twice (release 1.6.0's `scripts/orchestrate.sh`, then the pinned one):

```text
ORCH_DRY_RUN=1 bash scripts/orchestrate.sh hi > <scratch>/args.txt
claude <the same arguments without --output-format stream-json --verbose> --model no-such-model-x < /dev/null
```

Cap: none needed. The model name is invalid, so the request is refused before any model runs ("There's an issue with the selected model (no-such-model-x)"), exit 1, cost 0 USD. The environment had both skills repositories set, so the skill-slice rules were in the list.

Before (1.6.0): seven warnings on stderr, one per write rule, each "Permission allow rule (--allowed-tools): Bash(git -C * <form>) has a wildcard before the rest of the command, so it also matches any options inserted at that position ...":
`branch --show-current`, `worktree list*`, `worktree add *`, `add *`, `commit *`, `merge *`, `reset --merge`. The read rules (`git -C * status*`, `diff*`, `log*`, `show*`, `rev-parse*`, `ls-files*`, `rev-list*`) drew no warning.

After (pinned): no warning for any rule that names the project folder (`git -C <repo> <form>` for all seven forms) or a skills repository (`git -C <skills repo> branch --show-current|worktree list*|worktree add *`). Warnings remain for the rules whose folder name still needs a `*`, the worktree's name:

- `Bash(git -C <repo>/.claude/worktrees/* branch --show-current)`, `... add *)`, `... commit *)` (3, every run);
- `Bash(git -C <config dir>/orchestration/skill-drafts/* branch --show-current)`, `... add *)`, `... commit *)` (3, only when a skills repository is set).

A first version also gave the worktree folders `worktree list*`; it drew a fourth warning each and was dropped (plain `git worktree list` covers it).

## Probe 2: the `AgentRow` render hook (worker rows)

No live session was run. `--max-budget-usd` works only with `--print`, and a print session draws no agent rows, so a capped session cannot show the row; an interactive session cannot carry the cap that C2 requires.

Evidence instead: `npm run test-dashboard` (2 min 10 s): `claude plugin validate` passed, then `claude plugin test`, which runs the mod against the 2.1.326 engine's own test host, passed 119 of 119 tests. Six of them cover the worker rows: the row text, attempts, width cuts (CJK, emoji, accents), the four roles plain or as `orchestration:<role>`, and two mounts of the `AgentRow` component through the engine, where a hook beneath the mod reads the props it handed down: `implementer s1 #2 risky · opus · 50.0k (25%) · Running the tests` with the pane off, no `body` for an `Explore` row, the person's own `body` kept, and no `body` when the state read is refused.
