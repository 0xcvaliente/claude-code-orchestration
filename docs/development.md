# Development

For contributors to this repository: the npm scripts, the repository layout, the rules to follow when you change something, how to build the plugin, the release steps, the paid benchmark and eval runs, and the diagrams. Users of the plugin need the [README](../README.md) instead. Terms: [glossary](glossary.md).

## Set up and check

```bash
npm install
npm run check        # typecheck, tests, check-agents and check-plugin at the same time; must pass before you finish
npm test             # the tests only (fake model, no API calls)
npm run typecheck    # the type check only
```

`npm run check` runs its four steps side by side (`scripts/check.mjs`). It prints each step's whole output under a `=== <step>: pass|FAIL, N s ===` header, and its last line is `check passed` or `check failed: <names>`. The tests take nearly all of its time. CI (`.github/workflows/ci.yml`) runs it on push and on pull request to main, then, since 2.0.0, installs the Claude Code CLI (2.1.331) and runs `npm run test-dashboard` (the 2.0.0 changelog notes that this step was not run on a CI runner before the release). `npm run check` must finish in under 5 minutes on the maintainer's machine.

**Test rules (2.0.0).**
- Tests never read this repository's git history. A comparison with an older version reads stored files under `src/fixtures/`: `judge-core-1.4.0.mjs`, `judge-core-1.6.1.mjs.txt` and `gates-1.6.1/` (`brief.mjs`, `run.mjs`, `state.mjs`). A test under `src/` never skips because history is missing; `bench/arms.test.mjs` still skips one test in a clone without the 0.3.0 ref ([limits.md](limits.md), G).
- A bound on the in-process work of the code under test is checked in CPU time (`process.cpuUsage`, through the helpers at the top of the two files, `cpuMs` in `src/judge.test.ts` and `cpuTimed` in `src/guards.test.mjs`), so it holds on a loaded machine. Tests of a deadline firing and tests that time a child process (the hook run as a process, the 20,000-word commands) stay on the wall clock. Some in-process checks in `src/judge.test.ts` still use the wall clock: growth ratios taken as the best of three runs, and loose backstops (the attached-value test's 60 s and 5 s bounds).

## npm scripts

| Script | What it does |
|---|---|
| `npm start`, `npm run orchestrate` | The native orchestrator, the main toolkit, interactive, with the pane loaded (`claude --agent orchestrator --plugin-dir dist/dashboard`) |
| `npm run check` | The first thing CI runs: typecheck, `npm test`, `check-agents` and `check-plugin`, at the same time; CI then also installs the Claude Code CLI and runs `npm run test-dashboard` |
| `npm test`, `npm run typecheck` | Unit tests (fake model, no API calls; one temp root, removed at the end) and the type check |
| `npm run check-agents`, `npm run sync-agents` | Find, or fix, drift between `src/config.ts` and `.claude/agents/*.md` |
| `npm run build-plugin`, `npm run check-plugin` | Build `dist/plugin` and `dist/dashboard`, or fail when the committed build is stale |
| `npm run auto`, `npm run native`, `npm run route` | Headless run with triage first; headless run of the orchestrator; triage only ([Headless runs](native-mode.md#headless-runs)) |
| `npm run test-dashboard` | The pane's own test (needs the `claude` CLI) |
| `npm run plain` | A plain interactive session in this repo: `claude --settings '{"agent":"","outputStyle":"Concise"}'`. A session opened here otherwise starts as the orchestrator |
| `npm run report` | An HTML timeline and per-role tables from the state dir, with an estimated cost at list prices ([Run report](logs.md#run-report)) |
| `npm run install-statusline` | Copy the status line script and print the setting ([Status lines](dashboard.md#status-lines)) |
| `npm run claude-update` | Check this repo against the installed Claude Code after an update; `-- --fix` repairs the machine, `-- --enable` turns the plugin on, `-- --write-source` updates the block list in the repo ([docs/claude-code-updates.md](claude-code-updates.md)) |
| `npm run soak` | The gate soak (2.0.1): a seeded, model-free run of random worker life cycles through the real hooks in `.claude/hooks`, checking nine invariants after every step. `-- --minutes N` (default 10, at most 60: a larger or unreadable value exits 2 and runs nothing), `--seed S`, `--sequences K`, `--concurrency C`, `--replay FILE`, `--save FILE`, `--hooks DIR`, `--plant`. Exit 0 clean, 1 with a violation (each with a `REPLAY` line), 2 on a usage error. Each sequence runs in its own temp project; the project's `.claude/state` is never touched ([probes soak](data/probes-2.0.1-soak.md)) |
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
.claude-plugin/      marketplace.json (written by npm run build-plugin; docs/marketplace.md)
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

The full rules are in `CLAUDE.md`, `docs/maintainer-notes.md` and `.claude/rules/agents.md`. `CLAUDE.md` holds the commands and rules every session needs. `docs/maintainer-notes.md` holds the release-by-release rules. `.claude/rules/agents.md` loads only when you touch agent, hook, settings or workflow files. In short:

**Models and agents.**
- Change models, effort, turn limits and the triage thresholds in `src/config.ts`, the one source of truth. Then run `npm run sync-agents`; `npm run check-agents` fails on drift.
- Model rule: Fable plans (the orchestrator, the SDK planner), Opus does the tasks (the implementer, the SDK writer and solo, the plain session of `npm run auto`), Sonnet does the rest. Haiku is not used.
- Do not add `memory:` to the orchestrator or the reviewer: it turns on Write and Edit for them.
- Never give the researcher or the reviewer a web tool that posts data, or Edit or Write.
- Do not set `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: both override the per-agent settings.
- Name built-in agents only in `.claude/hooks/builtin-agents.mjs` (`BUILTIN_AGENTS`). After a Claude Code update, run `npm run claude-update`.

**Texts that must agree.** The nudge, the `route` skill and the orchestrator describe the same three routes and the same output rule. Change them together. Name switches (`ORCH_*`) only in maintainer text, never in agent bodies, skills or the nudge's context; `src/contracts.test.ts` checks this.

<a id="a-new-block-reason"></a>

**A new block reason (2.1.0).** `.claude/hooks/reasons.mjs` lists every reason the plan check (`PLAN_CHECK_BLOCK_REASONS`) and the review gate (`REVIEW_GATE_BLOCK_REASONS`) block with. It imports nothing and no hook imports it: `plan-check.mjs` and `review-gate.mjs` keep their own string literals, so a copy of the hooks without it blocks as before. A reason a hook adds goes into four places together: the hook, `reasons.mjs`, the "Block reasons" section of `.claude/agents/orchestrator.md`, and the pane's `GATE_REASONS` and `GATE_PHRASES` in `dashboard/register.tsx`. `src/contracts.test.ts` compares the hooks' code, the module and the orchestrator's list both ways; `src/reasons.test.mjs` compares the pane's lists (and the built `dist/dashboard`) with the module.

**Tests.**
- `npm test` runs `scripts/run-tests.mjs`. It runs two suites (the `src/*.test.ts` and `src/*.test.mjs` files, then `node --test bench/*.test.mjs`) with one temp root as `TMPDIR`, and removes the root at the end. `ORCH_KEEP_TEST_TMP=1` keeps it.
- Since 2.1.0 the src suite runs through `node:test` `run()` under tsx, at the CLI's concurrency (available parallelism − 1), and starts the files `SLOW_FIRST` names first, slowest first, then the rest in name order. `node --test` alone sorts by name, which started the four slow `skill-*` files about 125 s in; a replay of measured file times gave about 326 s against 367 s ([probes 2.1.0, suite](data/probes-2.1.0-suite.md)). `src/run-tests.test.mjs` fails when `SLOW_FIRST` names a file that no longer exists; add a new slow file there.
- The suite's wall time depends on the machine's load: a test that waits for a hook uses a marker or a poll, never a fixed sleep or a tight wall-clock window ([Limits](limits.md), J).
- Every test file imports `./test-tmp.mjs` (from `bench/`: `../src/test-tmp.mjs`) as its first import, so a file run on its own makes and removes its own `orch-test-*` root. `src/test-tmp.test.mjs` fails when one does not.
- The test gate's hardening tests are split in three files: `src/gate-hardening-time.test.mjs` (time limit and hook budget), `src/gate-hardening-trap.test.mjs` (temp folder, `run_limited`) and `src/gate-hardening-logs.test.mjs` (the rest).
- To hit a race in a shell script at an exact line, set a DEBUG trap in a file named by `BASH_ENV`: bash runs the trap before each command, and the trap can send the signal when `$BASH_COMMAND` is the command under test. `src/statusline.test.ts` sends a TERM just before `STATUS_PID=$!` and `WATCH_PID=$!` this way (2.1.0), with no timing window.
- To test a hook script by hand in zsh, pass the JSON with `printf '%s'`, not `echo`: zsh expands `\n`.

**After a change under `.claude/` or `dashboard/`,** rebuild the plugin (next section) and bump `version` in `package.json`, so installed copies pick up the change.

## Build the plugin

```bash
npm run build-plugin    # assemble dist/plugin and dist/dashboard, and write .claude-plugin/marketplace.json
npm run check-plugin    # fail when the committed build or the marketplace file is stale
claude plugin validate . --strict                        # check the marketplace manifest
claude plugin validate dist/plugin --strict              # check the built plugin
claude plugin validate --profile directory dist/plugin   # what Claude's plugin directory would refuse
claude --plugin-dir dist/plugin                          # try it in a session
```

What the build does:
- **Agent names.** Plugin agents carry a namespace (`orchestration:<name>`). The build rewrites the orchestrator's allowlist and the test gate's hook matcher to that form, and the hooks compare the bare role name. The first live plugin run showed that the namespaced name silently turned off both gates; `hooks.test.ts` now covers plain and namespaced names.
- **What it leaves out.** Plugin builds do not carry `hooks`, `permissionMode` or `mcpServers` from agent frontmatter. Project permission denies are not part of a plugin.
- **Workflows.** It ships `.claude/workflows/*.js` as plugin workflows, with every `agentType` rewritten to `orchestration:<role>`.
- **Evals.** It copies the repo-root `evals/` into the plugin, for `claude plugin eval`.
- **Hooks.** It registers `judge-hook.mjs` (PreToolUse on `Bash`) and `prompt-capture.mjs` (UserPromptSubmit) in `hooks/hooks.json` only when those files exist in `.claude/hooks`, and wraps the judge hook for `onFailure: "block"`. It also registers `compact-context.mjs`, `researcher-guard.mjs`, `egress-guard.mjs`, `read-log.mjs` and `quote-check.mjs` (matcher `orchestration:researcher`).
- **Settings.** It writes the 22 `userConfig` settings (`OPTIONS` in `scripts/build-plugin.mjs`) into `plugin.json`. Since 1.6.1 it writes no plugin `settings.json`: the worker rows are the mod's `AgentRow` hook, and `.claude/hooks/subagent-statusline.mjs` ships for a person's own `subagentStatusLine` setting.
- **The pane.** It builds `dashboard/` into the plugin (with its state owner renamed to `orchestration`) and alone as `dist/dashboard`.
- **The marketplace.** Since 2.0.2 it writes `.claude-plugin/marketplace.json` (one entry, `orchestration` at `./dist/plugin`, with no `version`: it lives in `plugin.json` only, which Claude Code would take anyway), and adds `homepage`, `repository` and `keywords` to both plugin manifests. The facts they share are `SHARED` in `scripts/build-plugin.mjs`. No manifest carries an email address ([Sharing the plugin](marketplace.md)).
- **License, README and icon.** Since 2.0.3 both plugin manifests carry `"license": "MIT"` (the marketplace entry does not), and the build copies the root `LICENSE` into `dist/plugin` and `dist/dashboard`. It copies `plugin-assets/README.md` and `plugin-assets/icon.png` into `dist/plugin` and sets `"icon": "./icon.png"` in its `plugin.json`. The build never renders `plugin-assets/icon.svg`: the PNG is committed, and `plugin-assets/NOTES.md` says how to regenerate it.

`npm run check-plugin` also fails, with `.claude-plugin/marketplace.json is out of date`, when that file differs from what the build writes or is missing. It skips only `dist/plugin/evals/results` and the two paths Claude Code writes when it loads the pane from `dist/dashboard`: `tsconfig.json` at that folder's root and `.claude-plugin/types/` (git ignores both). A stale file under any other `results` path fails it. A failure lists `Files differ: <path>` and `Only in <dir>: <path>` lines.

## Release steps

How releases 1.2.2 to 1.5.0 were made, and 1.5.1 on. `X.Y.Z` is the new version.

1. Set `version` to `X.Y.Z` in `package.json` and in `package-lock.json`, which names it twice (at the top and under `packages[""]`).
2. Add one entry `## [X.Y.Z] - <date>` to `CHANGELOG.md`, above the latest one: an opening paragraph that says what the release is and what a person upgrading has to know, then the sections the release needs, out of `### Added`, `### Changed`, `### Fixed` and, since 2.0.0, `### Limits`: one paragraph pointing to [limits.md](limits.md), which lists everything the release does not do with its reason (2.0.0 and later carry no `### Known and not fixed` list). When a changed behaviour asks something of a person, its item says what to do. Add `[X.Y.Z]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/vX.Y.Z` as the first line of the link definitions at the end. Never edit a released entry.
3. Run `npm run build-plugin`. The plugin manifests in `dist/` take the version from `package.json`; the marketplace entry in `.claude-plugin/marketplace.json` carries none, so `plugin.json` alone sets it. People get the release only because the version changed.
4. Run `npm run check`. It must pass; its `check-plugin` step compares the marketplace file too. Then run `claude plugin validate . --strict` and `claude plugin validate dist/plugin --strict`: neither may report an error. Since 2.0.3 also run `claude plugin validate --profile directory dist/plugin`: it may report no blocking item.
5. Commit on a branch, push it and open a pull request into `main`. Wait until CI passes.
6. Squash-merge it with the title `Release X.Y.Z: <summary> (#N)`, where `N` is the pull request's number (only 1.4.3's title had no summary): `gh pr merge <N> --squash --subject "Release X.Y.Z: <summary> (#N)"`. Pass `--subject`: the repository's squash title setting takes the commit's subject when the pull request has one commit. To keep a private address out of the merge commit, switch on "Keep my email addresses private" in the GitHub account (Settings, Emails) before you merge. With it on, GitHub authors its web-based Git operations, such as a merge, with the account's noreply address, and that address cannot be changed. With it off, `--author-email` with the noreply address is refused with `Invalid email address` (seen on 2026-11-16).
7. Tag the merge commit on `main` with a lightweight tag `vX.Y.Z` (`git tag vX.Y.Z <merge commit>`, no `-a`), and push that tag on its own (`git push origin vX.Y.Z`).
8. Create a GitHub Release from the tag, titled `X.Y.Z: <summary>`, with the changelog entry, without its heading line, as its notes. In the notes, rewrite each relative link of the entry to `https://github.com/0xcvaliente/claude-code-orchestration/blob/vX.Y.Z/<path>`, since a relative link leads nowhere on a release page; the link in `CHANGELOG.md` stays relative (`gh release create vX.Y.Z --title "X.Y.Z: <summary>" --notes-file <file>`).
9. On each machine that uses the plugin, run `npm run claude-update`; `-- --fix` runs `claude plugin update` for an installed copy whose version differs from the checkout's and adds a missing sandbox `allowWrite` entry ([docs/claude-code-updates.md](claude-code-updates.md#what---fix-and---write-source-change)).

## Benchmark and eval suite

The benchmark and the eval suite cost money: they run real model sessions.

```bash
npm run bench:validate                                # check every task's graders, no model calls (free)
npm run bench -- --matrix bench/matrix/<name>.json    # one benchmark campaign (paid)
npm run eval -- --case t2-single --runs 1 --ablation none --max-cost-usd 2   # one bounded eval run (paid)
```

`npm run bench:validate` makes no model call. It runs half the CPUs' worth of tasks at once (at least 2; `--parallel N` sets it), the three known slow tasks first, and stops at a deadline of 270 s (`--deadline-s S`, 0 for none): it prints the finished tasks, names each unfinished one (`NOT DONE`) and exits 3. `node bench/validate.mjs --task <id>` validates one task.

The eval suite was smoke-run on 2026-11-10 with the bounded command above, twice, at about $0.37 each. It runs end to end, and 4 of 7 graders passed. How the benchmark works: [bench/README.md](../bench/README.md); every result: [bench/RESULTS.md](../bench/RESULTS.md).

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
