# Documentation

This is the index of every documentation page in this repository. Each line says which question the page answers. New readers start at the top; maintainers mostly use "Reference". Terms are defined once, in the [glossary](glossary.md).

## Start here

- [The README](../README.md): what is this plugin, how do I install it, and what do I type first?
- [Sharing the plugin](marketplace.md): how do I add this marketplace, stay on a stable release and get updates?
- [Glossary](glossary.md): what does a term in these docs mean?
- [What Claude Code ships vs what this plugin adds](native-vs-plugin.md): what does the plugin add on top of Claude Code, and how is each claim measured?
- [Safety](safety.md): what protects against what, and what does not?
- [Limits](limits.md): what does this release not do, and why?

## How it works

- [How the native orchestrator works](native-mode.md): how does a task run, from triage to the final report? Roles, paths, retries, parallel slices, headless runs, the gated workflow and the plugin.
- [Gates and guards](gates.md): what does each gate or guard block, with which reason code?
- [Skills in the orchestrator](skills.md): how do workers use installed skills, and how does a run draft a new one?
- [The pane and status lines](dashboard.md): how do I watch a run beside the chat?

## Reference

- [Settings and switches](settings.md): which plugin settings and environment variables exist, and what does each one do?
- [Brief and reply grammar](brief-grammar.md): which lines must a brief or a reply hold, and how do the gates compute a run from them?
- [Logs and reports](logs.md): where do the hooks log, and how do I get a report of a run (`npm run report`)?
- [The Bash judge](bash-judge.md): how are pushes, remote changes and recursive deletes judged?
- [After a Claude Code update](claude-code-updates.md): what do I run after Claude Code updates itself?
- [SDK pipeline](sdk-pipeline.md): how do I run the older, frozen SDK pipeline (`npm run sdk`)?
- [Development](development.md): how do I change this repository? Scripts, layout, rules, the plugin build, releases and diagrams.
- [Benchmark](../bench/README.md): how do I run the benchmark and the plugin eval suite, and read a result?

## Records

Dated records. They are not edited after they are written.

- [CHANGELOG](../CHANGELOG.md): what changed in each release.
- [Benchmark results](../bench/RESULTS.md): every benchmark campaign's result in short.
- Benchmark write-ups: [built-in subagents blocked](benchmark-builtins-blocked.md), [compare-040](benchmark-compare-040.md), [route-040](benchmark-route-040.md), [short k2 run](benchmark-short-k2.md), [onext](benchmark-onext.md), and the generated [benchmark report of 2026-10-15](benchmarks.md).
- [Pre-registered hypotheses](../bench/HYPOTHESES.md): the benchmark's hypotheses and verdict rules, written before the runs.
- [Audit, 2026-11-16](research-2026-11-16.md): every finding of that audit and its status. Raw notes: [data/audit-2026-11-16/](data/audit-2026-11-16/).
- [Research of 2026-11-10](research-2026-11-10.md) and [research of 2026-10-31](research-2026-10-31.md): the research behind 1.2.0 and 0.4.0.
- [Live checks, 2026-11-17](data/live-checks-2026-11-17.md) and [live checks for 1.6.1](data/live-checks-2026-11-17-b.md): the probes behind 1.6.0 and 1.6.1.
- [Probes for 2.0.0](data/): `probes-2.0.0-b1.md`, `-b2.md`, `-f4.md`, `-w2.md` and `-w4.md`, cited by the 2.0.0 changelog and [Limits](limits.md).
- [Probes for 2.0.1](data/): `probes-2.0.1-reviewer-loop.md`, `-stop-gate.md`, `-soak.md` (the gate soak, `npm run soak`) and `-ci.md`, cited by the 2.0.1 changelog and [Limits](limits.md), I.
- [Run data and live checks](data/): raw campaign data and the other live probes behind the gates.
