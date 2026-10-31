# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-31

1.1.0 is the first stable release and the first tagged one. It is 0.4.0 plus the follow-ups listed under Fixed and Added. There was no 1.0.0 tag, and the versions before this one were not tagged.

### Fixed

- A slice is final only when its escalation rule is met: its latest review passed and it has no doubt signal, or a passing opus review came after its latest attempt. A run no longer closes on a sonnet pass that still needs an opus review, so that review and any further launch of the slice join the same run (ea62c55; [README, The gates](README.md#the-gates), [docs/brief-grammar.md, Run model](docs/brief-grammar.md#run-model)).

### Added

- `ORCH_SESSION_PERSISTENCE=1` keeps session and subagent transcripts in headless runs (`npm run native`, `npm run auto`, the bench), so telemetry records per-agent tokens, turns and models. Unset, headless runs behave as before (ec46ad9; [README, Telemetry and the read log](README.md#telemetry-and-the-read-log)).
- The `d3-reader` bench task (twelve questions over seven documents), the `reader-haiku`, `reader-sonnet` and `reader-routed` arms, and the route-040 benchmark of the read router (17fe23b, 69535bb). Results at n = 2 runs per arm, one task, direction only: the routed arm scored higher than the other two with fewer researcher tokens than `reader-sonnet`, but the model raise and the converted-text notes are confounded, and H14 is not called supported ([docs/benchmark-route-040.md](docs/benchmark-route-040.md)).
- A live probe of the `agent.spawn` mod hook for workflow agents: it runs under `claude -p`, fires for workflow agents and can rewrite their model and prompt. Routing workflow agents this way is feasible but not implemented (724d66f, 9ff6199; [docs/data/live-checks-workflow.md](docs/data/live-checks-workflow.md)).

### What 0.4.0 brought

Details in [README, What 0.4.0 adds to the gates](README.md#what-040-adds-to-the-gates) and [docs/research-2026-10-31.md, Implementation status](docs/research-2026-10-31.md#implementation-status-040).

- Brief and reply lines: `SOURCES:` and `READ:`, `KIND: bugfix`, `VALIDATE: gaps`, `SKILLS:`, `GAP: <0-100>` and `QUOTE:` ([Briefs and replies](README.md#briefs-and-replies)).
- Review precision: the gap cutoff (`ORCH_GAP_MIN`, default 80), validation of gaps before a retry, opus on the third attempt, and the native stall gate (`replan_required`).
- The test baseline (`inform` by default, `allow` opt-in) and the bugfix check for `KIND: bugfix` slices.
- Guards: the researcher Bash guard and the reviewer egress guard, both deny-only. The quote check for researcher `QUOTE:` lines. Plan and constraint re-injection after compaction (`compact-context.mjs`).
- The read router, opt-in (`ORCH_READ_ROUTER=on`) ([How a worker launch is shaped](README.md#how-a-worker-launch-is-shaped)).
- Skill suggestions in the plan check, on by default (`ORCH_SKILL_HINTS=off` to drop).
- Telemetry v2: tokens, turns, models and max-turn hits per agent, the file trail and the read log.
- 15 plugin settings as `userConfig`, bridged to the `ORCH_*` variables; an environment variable still wins ([Switches and plugin settings](README.md#switches-and-plugin-settings)).
- The gated workflow (shipped in 0.3.0) gained `gapMin`, `planCheck`, `planReview`, `refute` and `escalateLast`, all on by default ([The gated workflow](README.md#the-gated-workflow)).
- The native Bash judge hook is registered with `onFailure: "block"` and a 120 s timeout.

### Stability

In 1.x, these do not change incompatibly:

- The brief and reply line grammar ([docs/brief-grammar.md](docs/brief-grammar.md)).
- Gate reason names, such as `file_overlap`, `not_in_plan`, `replan_required` and `opus_review_required` ([README, The gates](README.md#the-gates)).
- The agent names (`researcher`, `implementer`, `reviewer`, `integrator`, `orchestrator`) and the `orchestration:` plugin namespace.
- The `userConfig` keys and the `ORCH_*` switches, with their defaults.
- The install path: marketplace `0xcvaliente/claude-code-orchestration`, plugin `orchestration`.

These stay opt-in or experimental and may change in a minor release:

- The read router (`ORCH_READ_ROUTER`); H14 is undecided.
- The native Bash judge hook (`ORCH_JUDGE=native`).
- The advisor (`ORCH_ADVISOR`).
- The eval suite (`npm run eval`), which has not been smoke-run.

Frozen: the SDK pipeline in `src/`, maintenance only since 0.3.0.

Known limitations are listed in [README, Known limitations](README.md#known-limitations).

### Upgrading

Installed plugin copies pick up the new version after a `/plugin` update or a reinstall, then `/reload-plugins`. No `userConfig` key or default changed after the 0.4.0 release commit (fc7360e), so there is nothing to migrate in settings. `ORCH_SESSION_PERSISTENCE` is a new environment variable for headless runs, not a `userConfig` key, and leaving it unset keeps the earlier behaviour. The one behaviour change is the finality rule above: a run waiting for a slice's opus review now stays open until that review runs or the run goes stale.

## Earlier versions (not tagged)

- 0.4.0 (56ec956 set the version; fc7360e completed the release with the README): see What 0.4.0 brought above.
- 0.3.0 (b193fdf): the gated workflow shipped in the plugin, the deny-only native Bash judge hook (opt-in), the plugin eval suite, native-workflow bench arms, and a plan-check fix for legacy records.
- 0.2.0 (e08d4ca): the review gate waits for running agents, run-scoped plan checks with plan conformance, the constraints ledger and opus escalation, and one parser for briefs.
- 0.1.1–0.1.13 (8c561fc to b287d2d): plugin packaging with the session nudge, a handback-aware review gate, runner detection, the per-implementer review loop guard, no double hook runs, plugin state outside user repos, and the dashboard pane.

[1.1.0]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.1.0
