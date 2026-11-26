# Documentation

The index of every page in `docs/`. Each line says what the page is for. Terms are defined once, in the [glossary](glossary.md). What each version changed: [Versions](../README.md#versions) in short, the [CHANGELOG](../CHANGELOG.md) in full.

## Start here

- [The README](../README.md): what the plugin is, how to [install](../README.md#install) it and what to type first.
- [What Claude Code ships vs what this plugin adds](native-vs-plugin.md): what the plugin adds, area by area, and how each claim is measured.
- [Sharing the plugin](marketplace.md): add the marketplace, stay on a release, get updates.
- [Glossary](glossary.md): every term these pages use, defined once.

## How it works

- [How the native orchestrator works](native-mode.md): how a task runs, from triage to the final report.
- [Gates and guards](gates.md): what each gate and guard blocks, and with which reason code.
- [Skills in the orchestrator](skills.md): how workers use installed skills, and how a run drafts a new one.
- [The pane and status lines](dashboard.md): how to watch a run beside the chat.

## Reference

- [Settings and switches](settings.md): every plugin setting and environment variable, with its default.
- [Brief and reply grammar](brief-grammar.md): the lines briefs and replies hold, and how the gates build a run from them.
- [Logs and reports](logs.md): what each log holds, and how `npm run report` reads them.
- [The Bash judge](bash-judge.md): how pushes, remote changes and recursive deletes are judged.
- [SDK pipeline](sdk-pipeline.md): the secondary, frozen pipeline (`npm run sdk`).

## Safety and limits

- [Safety](safety.md): what protects your machine and repository, and what does not. Read it before a run on a repository you care about.
- [Limits](limits.md): what the current release does not do, and why.

## Benchmarks

- [Benchmark guide](../bench/README.md): how to run the benchmark and the eval suite, and how to read a result.
- [Benchmark results](../bench/RESULTS.md): every campaign's result in short.
- [Pre-registered hypotheses](../bench/HYPOTHESES.md): the hypotheses and verdict rules, written before the runs.
- [Built-in subagents blocked](benchmark-builtins-blocked.md): orchestrator vs plain sessions with the built-in subagents blocked (2026-10-15). Its generated report: [benchmark-builtins-blocked-report.md](benchmark-builtins-blocked-report.md).
- [O-next](benchmark-onext.md): revised proposals vs the orchestrator as shipped (2026-10-16).
- [Comparison run](benchmark-compare-040.md), [read router run](benchmark-route-040.md) and [short k2 run](benchmark-short-k2.md): three small runs of 2026-10-31 that show direction only.
- [Generated benchmark report](benchmarks.md): the report of 2026-10-15, written by `bench/report.mjs`.

## For maintainers

- [Development](development.md): scripts, layout, rules, the plugin build, releases and diagrams.
- [Maintainer notes](maintainer-notes.md): the rules each release added, release by release. Read before you change hooks, gates, the build or the release process.
- [After a Claude Code update](claude-code-updates.md): what to run after Claude Code updates itself, and what each check means.

## Records

Dated records. They are not edited after they are written.

- [CHANGELOG](../CHANGELOG.md): what changed in each release.
- Research: [2026-10-31](research-2026-10-31.md) and [2026-11-10](research-2026-11-10.md), each a study of Claude Code changes and what the plugin should do about them.
- [Audit of 2026-11-16](research-2026-11-16.md): every finding of that audit and its status. Raw notes in [data/audit-2026-11-16/](data/audit-2026-11-16/).
- [data/](data/): live checks, probes and raw campaign data, each for one release. The CHANGELOG and [Limits](limits.md) cite them by name.
- [diagrams/](diagrams/): the diagram sources and the SVGs built from them.
