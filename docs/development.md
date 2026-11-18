# Development

For contributors to this repository: the npm scripts, the repository layout, the rules to follow when you change something, how to build the plugin, the release steps, the paid benchmark and eval runs, and the diagrams. Users of the plugin need the [README](../README.md) instead. Terms: [glossary](glossary.md).

## Set up and check

```bash
npm install
npm run check        # typecheck, tests, check-agents and check-plugin at the same time; must pass before you finish
npm test             # the tests only (fake model, no API calls)
npm run typecheck    # the type check only
```

`npm run check` runs its four steps side by side (`scripts/check.mjs`). It prints each step's whole output under a `=== <step>: pass|FAIL, N s ===` header, and its last line is `check passed` or `check failed: <names>`. The tests take nearly all of its time. CI (`.github/workflows/ci.yml`) runs it on push and on pull request to main. It must finish in under 5 minutes on the maintainer's machine.

**Test rules (2.0.0).**
- Tests never read this repository's git history. A comparison with an older version reads stored files under `src/fixtures/`: `judge-core-1.4.0.mjs`, `judge-core-1.6.1.mjs.txt` and `gates-1.6.1/` (`brief.mjs`, `run.mjs`, `state.mjs`). A test under `src/` never skips because history is missing; `bench/arms.test.mjs` still skips one test in a clone without the 0.3.0 ref ([limits.md](limits.md), G).
- A bound on the in-process work of the code under test is checked in CPU time (`process.cpuUsage`, the `cpuMs` helpers at the top of `src/judge.test.ts` and `src/guards.test.mjs`), so it holds on a loaded machine. Tests of a deadline firing and tests that time a child process (the hook run as a process, the 20,000-word commands) stay on the wall clock. Some in-process checks in `src/judge.test.ts` still use the wall clock: growth ratios taken as the best of three runs, and loose backstops (the attached-value test's 60 s and 5 s bounds).

## npm scripts

| Script | What it does |
|---|---|
| `npm start`, `npm run orchestrate` | The native orchestrator, the main toolkit, interactive, with the pane loaded (`claude --agent orchestrator --plugin-dir dist/dashboard`) |
| `npm run check` | Everything CI runs: typecheck, `npm test`, `check-agents` and `check-plugin`, at the same time |
| `npm test`, `npm run typecheck` | Unit tests (fake model, no API calls; one temp root, removed at the end) and the type check |
| `npm run check-agents`, `npm run sync-agents` | Find, or fix, drift between `src/config.ts` and `.claude/agents/*.md` |
| `npm run build-plugin`, `npm run check-plugin` | Build `dist/plugin` and `dist/dashboard`, or fail when the committed build is stale |
| `npm run auto`, `npm run native`, `npm run route` | Headless run with triage first; headless run of the orchestrator; triage only ([Headless runs](native-mode.md#headless-runs)) |
| `npm run test-dashboard` | The pane's own test (needs the `claude` CLI) |
| `npm run plain` | A plain interactive session in this repo: `claude --settings '{"agent":"","outputStyle":"Concise"}'`. A session opened here otherwise starts as the orchestrator |
| `npm run report` | An HTML timeline and per-role tables from the state dir, with an estimated cost at list prices ([Run report](logs.md#run-report)) |
| `npm run install-statusline` | Copy the status line script and print the setting ([Status lines](dashboard.md#status-lines)) |
| `npm run claude-update` | Check this repo against the installed Claude Code after an update; `-- --fix` repairs the machine, `-- --enable` turns the plugin on, `-- --write-source` updates the block list in the repo ([docs/claude-code-updates.md](claude-code-updates.md)) |
| `npm run skill-publish` | List draft skills; `-- <name>` pushes a draft and opens its pull request, `--merge` merges, installs and removes the draft, `--dry-run` prints the steps ([Publishing](skills.md#publishing)) |
| `npm run eval` | `claude plugin eval` on `dist/plugin` with the cases in `evals/` (paid, `--max-cost-usd 10`) ([Plugin eval suite](../bench/README.md#plugin-eval-suite)) |
| `npm run bench`, `bench:validate`, `bench:grade`, `bench:analyze`, `bench:report` | The benchmark ([bench/README.md](../bench/README.md)) |
| `npm run sdk` | The older SDK pipeline, frozen, with triage ([docs/sdk-pipeline.md](sdk-pipeline.md)) |

## Repository layout

```
.claude/
  agents/            orchestrator, researcher, implementer, integrator, reviewer
  hooks/             plan-check.mjs (plan check, read router, skill suggestions), verify.sh and bugfix-check.mjs (test gate,
                     test baseline, bugfix check), review-gate.mjs, quote-check.mjs, researcher-guard.mjs, egress-guard.mjs,
                     handback-check.mjs (report check and hand-back capture), compact-context.mjs, journal.mjs,
                     telemetry.mjs, read-log.mjs, turn-budget.mjs (turn warning), nudge.mjs, brief.mjs (the parser),
                     run.mjs, state.mjs, file-profile.mjs, skill-catalog.mjs, skill-hint.mjs, judge-hook.mjs,
                     judge-core.mjs, prompt-capture.mjs, test-cmd.sh, builtin-agents.mjs (the one list of Claude Code's
                     built-in subagent types), skill-gate.mjs (the skill gate), skill-seal.mjs (a draft skill's seal),
                     skill-scan.mjs (a library shared by the skill gate and npm run skill-publish),
                     workflow-guard.mjs and workflow-hash.mjs (the workflow guard and the saved workflow's hashes),
                     subagent-statusline.mjs (kept for a person who names it in their own subagentStatusLine; the
                     plugin ships no settings.json, and the worker rows come from the mod's AgentRow hook)
  skills/            route, orchestration-conventions, skill-authoring
  workflows/         orchestrate.js (the gated workflow)
  settings.json, rules/
.claude-plugin/      marketplace.json
dist/plugin/, dist/dashboard/   the built plugin, and the pane's mod alone (both committed)
dashboard/           the pane (source for both builds)
statusline/          statusline.sh
src/                 the SDK pipeline (config.ts is the source of truth for roles and thresholds) and the tests
scripts/             check.mjs (npm run check), run-tests.mjs (npm test), auto.sh, orchestrate.sh, build-plugin.mjs,
                     report.mjs and prices.mjs (npm run report), tokens.mjs, test-dashboard.mjs, sandbox-smoke.mjs,
                     install-statusline.sh, claude-update.mjs (the check after a Claude Code update),
                     skill-publish.mjs (a person publishes a draft skill),
                     run-result.mjs and log-run.mjs (a headless run's result document and its row in runs.jsonl)
evals/               the plugin eval suite
bench/               the benchmark: run, grade, analyze, report, tasks/, matrix/
docs/                the documentation (index: docs/README.md), data/ (run data, live checks), diagrams/
```

## Contributor rules

The full rules are in `CLAUDE.md` and `.claude/rules/agents.md`. `CLAUDE.md` holds the commands and rules every session needs. `.claude/rules/agents.md` loads only when you touch agent, hook, settings or workflow files. In short:

**Models and agents.**
- Change models, effort, turn limits and the triage thresholds in `src/config.ts`, the one source of truth. Then run `npm run sync-agents`; `npm run check-agents` fails on drift.
- Model rule: Fable plans (the orchestrator, the SDK planner), Opus does the tasks (the implementer, the SDK writer and solo, the plain session of `npm run auto`), Sonnet does the rest. Haiku is not used.
- Do not add `memory:` to the orchestrator or the reviewer: it turns on Write and Edit for them.
- Never give the researcher or the reviewer a web tool that posts data, or Edit or Write.
- Do not set `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: both override the per-agent settings.
- Name built-in agents only in `.claude/hooks/builtin-agents.mjs` (`BUILTIN_AGENTS`). After a Claude Code update, run `npm run claude-update`.

**Texts that must agree.** The nudge, the `route` skill and the orchestrator describe the same three routes and the same output rule. Change them together. Name switches (`ORCH_*`) only in maintainer text, never in agent bodies, skills or the nudge's context; `src/contracts.test.ts` checks this.

**Tests.**
- `npm test` runs `scripts/run-tests.mjs`. It runs two suites (`tsx --test src/*.test.ts src/*.test.mjs` and `node --test bench/*.test.mjs`) with one temp root as `TMPDIR`, and removes the root at the end. `ORCH_KEEP_TEST_TMP=1` keeps it.
- Every test file imports `./test-tmp.mjs` (from `bench/`: `../src/test-tmp.mjs`) as its first import, so a file run on its own makes and removes its own `orch-test-*` root. `src/test-tmp.test.mjs` fails when one does not.
- The test gate's hardening tests are split in three files: `src/gate-hardening-time.test.mjs` (time limit and hook budget), `src/gate-hardening-trap.test.mjs` (temp folder, `run_limited`) and `src/gate-hardening-logs.test.mjs` (the rest).
- To test a hook script by hand in zsh, pass the JSON with `printf '%s'`, not `echo`: zsh expands `\n`.

**After a change under `.claude/` or `dashboard/`,** rebuild the plugin (next section) and bump `version` in `package.json`, so installed copies pick up the change.

## Build the plugin

```bash
npm run build-plugin    # assemble dist/plugin and dist/dashboard
npm run check-plugin    # fail when the committed build is stale
claude plugin validate dist/plugin    # check the built plugin
claude --plugin-dir dist/plugin       # try it in a session
```

What the build does:
- **Agent names.** Plugin agents carry a namespace (`orchestration:<name>`). The build rewrites the orchestrator's allowlist and the test gate's hook matcher to that form, and the hooks compare the bare role name. The first live plugin run showed that the namespaced name silently turned off both gates; `hooks.test.ts` now covers plain and namespaced names.
- **What it leaves out.** Plugin builds do not carry `hooks`, `permissionMode` or `mcpServers` from agent frontmatter. Project permission denies are not part of a plugin.
- **Workflows.** It ships `.claude/workflows/*.js` as plugin workflows, with every `agentType` rewritten to `orchestration:<role>`.
- **Evals.** It copies the repo-root `evals/` into the plugin, for `claude plugin eval`.
- **Hooks.** It registers `judge-hook.mjs` (PreToolUse on `Bash`) and `prompt-capture.mjs` (UserPromptSubmit) in `hooks/hooks.json` only when those files exist in `.claude/hooks`, and wraps the judge hook for `onFailure: "block"`. It also registers `compact-context.mjs`, `researcher-guard.mjs`, `egress-guard.mjs`, `read-log.mjs` and `quote-check.mjs` (matcher `orchestration:researcher`).
- **Settings.** It writes the 22 `userConfig` settings (`OPTIONS` in `scripts/build-plugin.mjs`) into `plugin.json`. Since 1.6.1 it writes no plugin `settings.json`: the worker rows are the mod's `AgentRow` hook, and `.claude/hooks/subagent-statusline.mjs` ships for a person's own `subagentStatusLine` setting.
- **The pane.** It builds `dashboard/` into the plugin (with its state owner renamed to `orchestration`) and alone as `dist/dashboard`.

`npm run check-plugin` skips only `dist/plugin/evals/results` and the two paths Claude Code writes when it loads the pane from `dist/dashboard`: `tsconfig.json` at that folder's root and `.claude-plugin/types/` (git ignores both). A stale file under any other `results` path fails it. A failure lists `Files differ: <path>` and `Only in <dir>: <path>` lines.

## Release steps

How releases 1.2.2 to 1.5.0 were made, and 1.5.1 on. `X.Y.Z` is the new version.

1. Set `version` to `X.Y.Z` in `package.json` and in `package-lock.json`, which names it twice (at the top and under `packages[""]`).
2. Add one entry `## [X.Y.Z] - <date>` to `CHANGELOG.md`, above the latest one: an opening paragraph that says what the release is and what a person upgrading has to know, then the sections the release needs, out of `### Added`, `### Changed`, `### Fixed` and, since 2.0.0, `### Limits`: one paragraph pointing to [limits.md](limits.md), which lists everything the release does not do with its reason (2.0.0 and later carry no `### Known and not fixed` list). When a changed behaviour asks something of a person, its item says what to do. Add `[X.Y.Z]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/vX.Y.Z` as the first line of the link definitions at the end. Never edit a released entry.
3. Run `npm run build-plugin`. The plugin manifests in `dist/` take the version from `package.json`.
4. Run `npm run check`. It must pass.
5. Commit on a branch, push it and open a pull request into `main`. Wait until CI passes.
6. Squash-merge it with the title `Release X.Y.Z: <summary> (#N)`, where `N` is the pull request's number (only 1.4.3's title had no summary): `gh pr merge <N> --squash --subject "Release X.Y.Z: <summary> (#N)"`. Pass `--subject`: the repository's squash title setting takes the commit's subject when the pull request has one commit. To keep a private address out of the merge commit, switch on "Keep my email addresses private" in the GitHub account (Settings, Emails) before you merge. With it on, GitHub authors its web-based Git operations, such as a merge, with the account's noreply address, and that address cannot be changed. With it off, `--author-email` with the noreply address is refused with `Invalid email address` (seen on 2026-11-16).
7. Tag the merge commit on `main` with a lightweight tag `vX.Y.Z` (`git tag vX.Y.Z <merge commit>`, no `-a`), and push that tag on its own (`git push origin vX.Y.Z`).
8. Create a GitHub Release from the tag, titled `X.Y.Z: <summary>`, with the changelog entry, without its heading line, as its notes. In the notes, rewrite each relative link of the entry to `https://github.com/0xcvaliente/claude-code-orchestration/blob/vX.Y.Z/<path>`, since a relative link leads nowhere on a release page; the link in `CHANGELOG.md` stays relative (`gh release create vX.Y.Z --title "X.Y.Z: <summary>" --notes-file <file>`).
9. On each machine that uses the plugin, run `npm run claude-update`; `-- --fix` updates a stale plugin install and adds a missing sandbox `allowWrite` entry ([docs/claude-code-updates.md](claude-code-updates.md)).

## Benchmark and eval suite

The benchmark and the eval suite cost money: they run real model sessions.

```bash
npm run bench:validate                                # check every task's graders, no model calls (free)
npm run bench -- --matrix bench/matrix/<name>.json    # one benchmark campaign (paid)
npm run eval -- --case t2-single --runs 1 --ablation none --max-cost-usd 2   # one bounded eval run (paid)
```

`npm run bench:validate` makes no model call. It runs half the CPUs' worth of tasks at once (at least 2; `--parallel N` sets it), slowest first, and stops at a deadline of 270 s (`--deadline-s S`, 0 for none): it prints the finished tasks, names each unfinished one (`NOT DONE`) and exits 3. `node bench/validate.mjs --task <id>` validates one task.

The eval suite was smoke-run on 2026-11-10 with the bounded command above, twice, at about $0.37 each. It runs end to end, and 4 of 7 graders passed. How the benchmark works and every result: [bench/README.md](../bench/README.md).

## Diagrams

The diagrams are SVG files in `docs/diagrams/`, each in a light and a dark version. To change one:

1. Edit its `*.scene.json`, or the sequence in `build.py`.
2. Run `python3 docs/diagrams/build.py`. It uses the diagram-craft skill's renderer.

## Optional: TypeScript code intelligence

This gives Claude type errors after edits and symbol lookup. This repo does not install it, because it downloads software; run it yourself:

```bash
npm install -g typescript-language-server typescript    # the language server
```

Then, inside `claude`: `/plugin install typescript-lsp@claude-plugins-official`.
