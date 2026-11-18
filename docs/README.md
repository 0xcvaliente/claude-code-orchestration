# Documentation

Every page of this repository's documentation, in one list. Start at the top if you are new; maintainers will mostly use "Reference".

Terms are defined once, in the [glossary](glossary.md).

## Start here

- [Documentation](README.md): this page, the index.
- [Claude Code orchestrator](../README.md) (the README): what the orchestrator does, how to install it, what to type first, and how triage picks a route.
- [Glossary](glossary.md): every term these docs use, defined in one or two sentences.
- [What Claude Code ships vs what this plugin adds](native-vs-plugin.md): area by area, what the plugin adds on top of Claude Code and how each claim is measured.
- [Safety](safety.md): what protects against what, what does not, and a link to every page's limits.
- [Limits](limits.md): everything release 2.0.1 does not do, each with its reason.

## How it works

- [How the native orchestrator works](native-mode.md): the roles, the light and full path, the plan review, retries, parallel slices, headless runs, the gated workflow and the plugin.
- [Gates and guards](gates.md): every gate and guard, what it blocks, its reason codes, loop guards and doubt signals.
- [Skills in the orchestrator](skills.md): how workers use installed skills, and how a run drafts a new skill that a person publishes.
- [The pane and status lines](dashboard.md): the live view of a run beside the chat, and the two status lines.

## Reference

- [Settings and switches](settings.md): every plugin setting and environment variable, with its default and effect.
- [Brief and reply grammar](brief-grammar.md): the exact lines in briefs and replies, and the run model the gates compute from them.
- [Logs and reports](logs.md): where the hooks log, what each log holds, telemetry, and `npm run report`.
- [The Bash judge](bash-judge.md): how pushes, remote changes and recursive deletes are judged, in SDK workers and in the opt-in native hook.
- [After a Claude Code update](claude-code-updates.md): what to run after Claude Code updates itself, and what the repo relies on.
- [SDK pipeline](sdk-pipeline.md): the secondary, frozen SDK pipeline in `src/` (`npm run sdk`): commands, flags, environment, outputs. The native orchestrator is the main entry ([How the native orchestrator works](native-mode.md)).
- [Development](development.md): for contributors: npm scripts, repository layout, rules, building the plugin, diagrams.
- [Benchmark](../bench/README.md): the benchmark harness, the plugin eval suite, and every campaign's result in short.

## Records

Dated records. They are not edited after they are written.

- [CHANGELOG](../CHANGELOG.md): what changed in each release.
- [Audit, 2026-11-16](research-2026-11-16.md): every finding of the 2026-11-16 audit, its status, and what stays unproven. Raw notes: [data/audit-2026-11-16/](data/audit-2026-11-16/).
- [Research of 2026-11-10](research-2026-11-10.md) and [research of 2026-10-31](research-2026-10-31.md): the research behind 1.2.0 and 0.4.0.
- Benchmark write-ups: [built-in subagents blocked](benchmark-builtins-blocked.md), [compare-040](benchmark-compare-040.md), [route-040](benchmark-route-040.md), [short k2 run](benchmark-short-k2.md), [onext](benchmark-onext.md), and the generated [benchmark report of 2026-10-15](benchmarks.md).
- [Pre-registered hypotheses](../bench/HYPOTHESES.md): the benchmark's hypotheses and verdict rules, written before the runs.
- [Live checks, 2026-11-17](data/live-checks-2026-11-17.md): the probes behind 1.6.0 (the triage call's hooks, title call and connectors, a triage stopped by the cap, the workflow guard).
- [Live checks for 1.6.1](data/live-checks-2026-11-17-b.md): the probes behind 1.6.1 (the typed prompt's transcript record, workflow resume and the guard live, the five other SDK roles, the pinned git rules' warnings and the worker rows).
- [Probes for 2.0.0](data/): `probes-2.0.0-b1.md`, `-b2.md`, `-f4.md`, `-w2.md` and `-w4.md`, the probes the 2.0.0 changelog and [Limits](limits.md) cite.
- [Probes for 2.0.1](data/): `probes-2.0.1-reviewer-loop.md` (a reviewer that goes on after its report), `-stop-gate.md` (implementer stops with no test-gate record) and `-soak.md` (the gate soak, `npm run soak`, and its findings), the probes the 2.0.1 changelog and [Limits](limits.md), I, cite.
- [Run data and live checks](data/): raw campaign data and the live probes behind the gates.
