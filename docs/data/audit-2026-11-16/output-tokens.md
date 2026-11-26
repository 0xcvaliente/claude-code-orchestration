# Audit: output tokens and visible text (2026-11-16, HEAD bc1dce8)

Slice `audit-output`. Goal (owner): after a prompt, "just simple bullet points or keywords rather than long text that uses much token".

## Summary

| id | kind | severity | title | files a change would touch |
|---|---|---|---|---|
| O-1 | behaviour-change | high | No output contract for the orchestrator: path line, plan, progress and report have open length | `.claude/agents/orchestrator.md`, `dist/plugin` (rebuild) |
| O-2 | behaviour-change | high | The plan is written twice: in the visible reply and in the PLAN REVIEW brief | `.claude/agents/orchestrator.md`, `.claude/skills/route/SKILL.md`, `.claude/hooks/nudge.mjs` |
| O-3 | behaviour-change | medium | Route skill and nudge leave visible text open (three-places rule) | `.claude/skills/route/SKILL.md`, `.claude/hooks/nudge.mjs`, `src/contracts.test.ts` |
| O-4 | behaviour-change | medium | Most main-session output is hidden reasoning (orchestrator `effort: high`) | `src/config.ts`, `.claude/agents/orchestrator.md` (sync) |
| O-5 | improvement | medium | Output style: built-in Concise fits plain sessions; unproven for `--agent` | `scripts/orchestrate.sh`, `package.json` (`plain`), optional `.claude/output-styles/` |
| O-6 | improvement | medium | Nudge context is 1,204 words, injected at each plugin session start | `.claude/hooks/nudge.mjs`, `src/contracts.test.ts`, route skill, orchestrator |
| O-7 | improvement | low | Two plan-check block messages name an environment switch | `.claude/hooks/plan-check.mjs`, `src/contracts.test.ts` |
| O-8 | improvement | low | Workflow logs the whole plan JSON twice and returns full gap texts | `.claude/workflows/orchestrate.js`, `src/workflow.test.mjs` |
| O-9 | behaviour-change | low | `npm run auto` / `native` print one JSON document to a terminal | `scripts/orchestrate.sh`, `scripts/auto.sh`, `src/verify.test.ts` |
| O-10 | improvement | medium | `src/gate-hardening.test.mjs` (60.2 s, sequential) sets the src suite's wall time | `src/gate-hardening.test.mjs` (split into files) |
| O-11 | improvement | low | Judge clamp test (39.7 s) and bench `executeRun` (8.2 s) wait on real clocks | `src/judge-hook.test.mjs`, `bench/run.test.mjs`, `src/verify.test.ts` |

Counts: behaviour-change 5 (high 2, medium 2, low 1); improvement 6 (medium 3, low 3); bug 0; known 0; docs-drift 0.

## Coverage

| file | examined |
|---|---|
| `.claude/agents/orchestrator.md` | full (1-59) |
| `.claude/agents/implementer.md`, `integrator.md`, `researcher.md`, `reviewer.md` | partial: frontmatter and every report/reply line (grep `words|Reply|report|STATUS|format|OPEN`) |
| `.claude/skills/route/SKILL.md` | full (1-51) |
| `.claude/skills/orchestration-conventions/SKILL.md` | full (loaded in this session) |
| `.claude/hooks/nudge.mjs` | full (1-43) |
| `.claude/hooks/compact-context.mjs` | full (1-106); capped at 1,500 chars, no finding |
| hook messages to a model (stderr exit 2, additionalContext, systemMessage) | partial: `review-gate.mjs` 170-296; `plan-check.mjs` 845-924, 1236-1242; `verify.sh` 425-446; `skill-hint.mjs` 282; every `stderr.write`/`additionalContext`/`systemMessage` site listed by grep; non-comment lines over 260 chars in 10 hook files |
| plan-check appended blocks (skill hints, read-router notes, skill facts, sources note) | partial: `HINT_INTRO` (`skill-hint.mjs:282`) only; router notes, skill facts and sources note not reached |
| `.claude/workflows/orchestrate.js` | partial: 355-392, 718-729 and every `log(`/`return` line |
| `scripts/auto.sh` | partial: every `echo`/`printf` line, 76-90 |
| `scripts/orchestrate.sh` | partial: every `echo`/`printf` line, 177-180 |
| `src/contracts.test.ts` | full (assertions 1-357) |
| `.claude/state/*.jsonl` | copies in scratch `audit/audit-output/state/`: `telemetry`, `gates`, `journal`, `handbacks` read; others not needed |
| `~/.claude/projects/<project>/*.jsonl` (5 main transcripts) | counts only, via `scripts/main-split.mjs` and `scripts/text-dist.mjs` in scratch |
| `baseline/check.log` | full for durations |

## Measurements

Scratch root below: `SCR=<scratch>`. Logs span 2026-10-22 to 2026-11-16.

### M1. Worker output vs cache reads, last SubagentStop record per agent (105 agents)

Command: `jq -s '[.[]|select(.hook_event_name=="SubagentStop" and .tokens!=null)]|group_by(.agent_id)|map(last)|group_by(.agent_type|sub("^orchestration:";""))|...' $SCR/audit/audit-output/state/telemetry.jsonl`

| role | agents | output | cache_read | cache_write | output per agent | output per 1,000 cache_read |
|---|---|---|---|---|---|---|
| implementer | 17 | 410,271 | 63,378,528 | 3,373,907 | 24,134 | 6.5 |
| reviewer | 42 | 331,669 | 29,694,805 | 3,686,193 | 7,897 | 11.2 |
| researcher | 20 | 282,854 | 11,885,388 | 1,944,359 | 14,143 | 23.8 |
| integrator | 26 | 31,640 | 2,067,298 | 358,816 | 1,217 | 15.3 |

Telemetry has no main-session (orchestrator) records; M4 covers it.

### M2. Worker turns lost to refusals (`gates.jsonl` copy; fixture session `s` excluded)

Command: `jq -r 'select(.gate=="researcher" and .session_id!="s")|.word+"\t"+.reason' gates.jsonl | sort | uniq -c`

| refused | count |
|---|---|
| `cd` | 10 |
| output redirection or heredoc | 7 |
| `sed` | 5 |
| `cut` | 4 |
| `git` (form not allowed) | 2 |
| `grep` (form not allowed) | 2 |
| `ls` with expansion | 2 |
| `stat`, `node`, `echo`, `bash`, substitution | 1 each |
| total | 37, over 17 researcher agents, 3 sessions |

Hand-back sends (`gate=="handback"`): researcher `no_status` 8; reviewer `checks_unanswered` 8 (15 in session b34157a4, 1 in this session).

### M3. Reviews and retries per slice (`journal.jsonl` copy, slice != plan, by session+slice)

Command: `jq -s '[.[]|select(.slice!=null and .slice!="plan")]|group_by(.session_id+"|"+.slice)|...' journal.jsonl`

| measure | value |
|---|---|
| slices | 26 |
| implementer stops | 38 (9 slices retried) |
| reviewer stops | 69 (15 failed) |
| reviews per slice: 1 / 2 / 3 / 4 / 6 / 7 / 14 | 11 / 7 / 3 / 2 / 1 / 1 / 1 |
| implementer stops per slice: 0 / 1 / 2 / 4 / 6 | 5 / 12 / 6 / 2 / 1 |
| plan reviews | 12 |

Review gate (`gate=="review"`): 120 `agents_running` allows, 14 `no_reviewer_after_last_implementer` blocks, 9 `max_blocks_reached`.

### M4. Main session output split (main transcripts, counts only)

Command: `node $SCR/audit/audit-output/scripts/main-split.mjs ~/.claude/projects/<repo key>/*.jsonl` (per message id: max `usage.output_tokens`; characters per block kind; estimate = chars/4; "rest" = output minus the three estimates, which is hidden reasoning: 225 of 225 thinking blocks in b34157a4 carry no text).

| session | messages | output tokens | visible text est. | briefs + SendMessage est. | tool input est. | rest (reasoning) |
|---|---|---|---|---|---|---|
| b34157a4 (58 prompts) | 272 | 641,245 | 33,718 (5.3%) | 123,847 (19.3%) | 7,968 (1.2%) | 475,712 (74.2%) |
| 3c44b35f (this run, in progress) | 21 | 124,928 | 1,999 (1.6%) | 10,791 (8.6%) | 1,846 | 110,292 (88.3%) |
| 7c2baf29 | 7 | 5,531 | 1,245 | 1,426 | 77 | 2,783 |
| 4eb0bb1b | 7 | 3,537 | 630 | 1,269 | 106 | 1,532 |

Visible words per message with text (`node $SCR/audit/audit-output/scripts/text-dist.mjs <transcript>`):

| session | messages with text | words | median | p90 | max | over 100 words | over 300 words |
|---|---|---|---|---|---|---|---|
| b34157a4 | 191 | 23,114 | 84 | 254 | 675 | 85 | 12 |
| 7c2baf29 | 6 | 888 | 154 | 331 | 331 | 4 | 1 |
| 4eb0bb1b | 5 | 378 | 39 | 182 | 182 | 2 | 0 |

### M5. Size of always-loaded model-facing text

Command: `wc -w .claude/agents/*.md .claude/skills/route/SKILL.md`; nudge: `CLAUDE_PROJECT_DIR=/private/tmp/x ORCH_NO_NUDGE= node .claude/hooks/nudge.mjs </dev/null | jq -r .hookSpecificOutput.additionalContext | wc -w`

| text | words |
|---|---|
| orchestrator.md | 3,860 |
| route SKILL.md | 2,244 |
| nudge additionalContext | 1,204 |
| reviewer / implementer / researcher / integrator | 1,335 / 793 / 709 / 458 |

### M6. Test wall time (baseline `check.log`, read only)

Command: `grep -oE '\(([0-9.]+)ms\)$'` over `$SCR/baseline/check.log`, summed per file by test name.

| item | value |
|---|---|
| test step | 74.4 s = src suite 61.0 s + bench suite 12.4 s (`scripts/run-tests.mjs` runs the two suites one after the other) |
| `src/gate-hardening.test.mjs` | 60.2 s over 21 tests, one file, so sequential: the src suite's critical path |
| `src/judge-hook.test.mjs` | 45.7 s over 18 tests (clamp test 39.7 s, already started at load and run beside the others) |
| `src/verify.test.ts` | 28.6 s over 33 tests |
| `bench/run.test.mjs` | 12.4 s over 21 tests (`executeRun` 8.2 s) |

Slowest tests: judge clamp 39.7 s (`src/judge-hook.test.mjs:316`); `run_limited` terminate/kill 16.2 s (`src/gate-hardening.test.mjs:189`); bugfix budget 10.3 s (`:151`); loop guard on a hung suite 9.4 s (`:93`); `executeRun` 8.2 s (`bench/run.test.mjs:173`); auto.sh STATUS verdict 7.8 s (`src/verify.test.ts:487`).

## Findings

### O-1: No output contract for the orchestrator

- kind: behaviour-change
- severity: high
- where: `.claude/agents/orchestrator.md:11`, `:13`, `:31`, `:42`, `:59`
- what happens today: the prompt asks for text to the person at five points and caps none: `:11` "Say which path you took and why in the first line of your reply."; `:13` "Then write the plan in your reply (at most 6 slices). Per slice: goal, files owned (...), acceptance check, the ids of the constraints ..., `RISKY: yes` ..., `KIND: bugfix` ..., and its skill decision"; `:31` "7. Report: per slice, status and evidence: the command and its result for code, otherwise the file and section, or the source URL, that shows each requirement is met."; `:42` "first propose it in your reply (its name, when it should trigger, the target, private unless you say public, and its catalog category)"; `:59` "say in your report which slices you reused". Nothing limits progress notes, retry or review narration. Workers are capped ("Workers reply in under 200 words", `:45`); the main session is not.
- reproduction: quoted lines above; M4: in b34157a4, 191 messages with text, median 84 words, p90 254, 85 over 100 words, 12 over 300; about 33.7k output tokens of visible text.
- expected behaviour: the owner's goal (top of file): bullets or keywords, no long text. Rules that must stay: path statement (`:11`), evidence for every success claim (`:31`, `:54`), constraints ledger and plan lines in the PLAN REVIEW brief (`:14`), the replan and skill-draft lines of the report (`:31`).
- fix scope: `.claude/agents/orchestrator.md` (body only, no frontmatter, so no `sync-agents`); `npm run build-plugin` (`dist/plugin/agents/orchestrator.md`); paired with O-3 (route skill, nudge: three-places rule, `.claude/rules/agents.md`). `src/contracts.test.ts` needs no change: it pins none of the replaced sentences. Pinned strings in `orchestrator.md` the edit must keep: `SLICE:`, `FILES:`, `DEPENDS:`, `PATH: light`, `PLAN REVIEW`, `SOURCES:`, `READ:`, `lookup|extract|judge`, `KIND: bugfix`, `VALIDATE: gaps`, `GAP: <0-100> <text>`, `QUOTE: <locator> | <verbatim text>`, `replan_required`, `not_in_plan`, `opus_review_required`, `builtin_agent_in_run`, "third and last attempt ... fresh ... opus", `model: "opus"`, `BRANCH`, `SKILLS: <comma-separated skill names>`, "clearly needs", "Never invent a skill name", "as the Skill tool lists it", "implementer, researcher or reviewer brief", "integrator", "plan check may append", "VALIDATE and SKILLS are optional", "at most two installed skills that shape the plan itself (domain rules, architecture, a threat model)", "every other fitting skill goes to the workers", "`SKILLS: <names>` or `SKILLS: none`", "a RISKY slice always carries one of the two", "stays in your context", "answer you write yourself" (exactly once), "narrowest command that proves the slice", "tests of the files it owns", "test gate runs the project's whole suite when an implementer stops", "the integrator runs it once more after the merge", "a brief never also asks a worker to run the whole suite", "the integrator's brief is the one that names the project's whole suite", step 5 line keeps "slice's own acceptance check" and "only the integrator's brief names the whole suite", step 0 keeps "at most 3 files AND under about 1,500 changed lines" and "large work (1,500+ lines)" and states no other number before "files"/"lines"; no environment switch name anywhere.
- risk: shorter final reports could drop evidence a reader needs; the evidence pointer per slice and "more only when asked" keep it reachable. Wording is a prompt rule, not enforced; a bench run (README "Why a router" tasks) should confirm review-gate outcomes do not change.
- confidence: 85

Proposed text. Replace in `:11`:

```text
Say which path you took and why in the first line of your reply.
```

with:

```text
State the path on the first line of your reply in the form Output to the person gives.
```

Replace in `:31`:

```text
7. Report: per slice, status and evidence: the command and its result for code, otherwise the file and section, or the source URL, that shows each requirement is met.
```

with:

```text
7. Report, in the final-report form of Output to the person: per slice, status and an evidence pointer: the command and its result for code, otherwise the file and section, or the source URL, that shows each requirement is met.
```

Replace in `:59` "say in your report which slices you reused" with "list the reused slices on one report line (`reused: <ids>`)".

Add after `## Reports` (`:44-45`):

```markdown
## Output to the person
The person reads keywords, not prose. Write short bullets or `key: value` lines; detail lives in briefs, the orchestration pane and the run report.
- Path (first line): `Path: light|full — <reason, at most 12 words>`.
- Plan (once, before the plan review or the light-path launch): one line per slice, `<id>: <goal, at most 10 words>` plus `RISKY` when it is; then `Constraints: C1-C<n>` (ids only). The full plan and the constraint texts go only into the PLAN REVIEW brief.
- Progress (only when something changed, or when you end a turn to wait): one line, at most 15 words, such as `s2: review failed, 2 gaps confirmed, retry 2` or `waiting: s1 review, s3 build`.
- Proposal that needs a yes (a new skill): one line, `Skill proposal: <name> — <trigger>; <target>; <category>. Yes?`.
- Final report, at most 15 lines: `Result: <n> passed, <n> failed`; one line per slice, `<id>: pass|fail — <evidence pointer, at most 15 words>`; then the lines that apply: `replaced: <id> -> <ids>`, `reused: <ids>`, `draft: <name> on <branch>, publishing is a separate step`, `unverified: <ids>`; last `Open: <items>` or `Open: none`.
- More detail (the plan in full, gaps, logs, reasoning) only when the person asks for it.
```

### O-2: The plan is written twice

- kind: behaviour-change
- severity: high
- where: `.claude/agents/orchestrator.md:13` and `:14`
- what happens today: `:13` "Then write the plan in your reply (at most 6 slices). Per slice: goal, files owned (...), acceptance check, ... `RISKY: yes` ..., `KIND: bugfix` ..., and its skill decision"; `:14` then requires the same plan in the PLAN REVIEW brief: "holds the task text verbatim, the researchers' findings and the plan. Write the ledger as a `CONSTRAINTS:` line followed by its `C<n>: <text>` lines. Start each slice with the lines ...". The person gets the full plan as prose, then the model writes it again as a brief. No hook reads the visible plan: the journal, plan check and pane read the PLAN REVIEW brief (`.claude/rules/agents.md`, "Brief lines": "`journal.mjs` logs it as slice `plan` with the parsed plan, and the dashboard's progress bar lists its slices"). `grep -rn "first line of your reply|path you took" bench evals src docs README.md` -> no output, so no grader reads the path line either.
- reproduction: quoted lines; M4: briefs and SendMessage are 19.3% (about 124k tokens) of b34157a4's output, visible text 5.3%.
- expected behaviour: owner's goal; plan review needs the plan only in its brief (`orchestrator.md:14`).
- fix scope: `.claude/agents/orchestrator.md:13`; `.claude/skills/route/SKILL.md:37` and `.claude/hooks/nudge.mjs:33` do not ask for a visible plan, so they change only through O-3. `dist/plugin` rebuild.
- risk: on the light path there is no PLAN REVIEW brief, so the one-line plan is the only record before launch; acceptable, the implementer brief and journal hold it.
- confidence: 80

Replace in `:13`:

```text
Then write the plan in your reply (at most 6 slices). Per slice:
```

with:

```text
Then write the plan (at most 6 slices) for the PLAN REVIEW brief (step 2a), and show the person only its summary lines (Output to the person). Per slice:
```

### O-3: Route skill and nudge leave visible text open

- kind: behaviour-change
- severity: medium
- where: `.claude/skills/route/SKILL.md:34`, `:35`, `:36`, `:37`; `.claude/hooks/nudge.mjs:30-35`
- what happens today: `SKILL.md:34` "Tell the user the mode and the reason in one or two sentences, then act on it."; the plain (`:35`), reviewed (`:36`) and orchestrate (`:37`) branches say nothing about the form of updates or the final report; the nudge's context (`nudge.mjs:30-35`) has no output rule. A plain-session orchestrator run through the route skill has none of O-1's contract.
- reproduction: quoted lines; `grep -n "words\|bullet\|short" .claude/skills/route/SKILL.md .claude/hooks/nudge.mjs` finds no length rule for text to the person.
- expected behaviour: owner's goal; `.claude/rules/agents.md` three-places rule: "Change them together so a session, a route and an orchestrator never disagree about what a route does."
- fix scope: `.claude/skills/route/SKILL.md`, `.claude/hooks/nudge.mjs`, together with O-1 in `orchestrator.md`; `dist/plugin`; optional new assertion in `src/contracts.test.ts` that all three name `<id>: pass|fail`. Pinned strings the route skill and nudge must keep: `plain`, `reviewed`, `orchestrate`; `SLICE:`, `FILES:`, `DEPENDS:`, `PATH: light`, `PLAN REVIEW`, `FOCUS:`, `implementer`, `reviewer`; the 0.4.0 tokens listed in O-1; the delegate sentence (`delegate with the Agent tool to ...` in both forms, `contracts.test.ts:203-204`); the SKILLS strings; the acceptance-check strings (`contracts.test.ts:317-331`); route skill `minParallelSlices 2` ... `reviewedMaxLines 200` and the rule numbers (`:43-48`); no switch names.
- risk: low; the nudge line adds about 40 words to every plugin session start (see O-6 for a net cut).
- confidence: 80

Replace `SKILL.md:34` first sentence:

```text
Tell the user the mode and the reason in one or two sentences, then act on it.
```

with:

```text
Tell the user `Route: <mode> — <reason, at most 12 words>` on one line, then act on it. Write to the user in short bullets or keywords throughout: one-line progress notes only when something changed, and a final report of at most 15 lines (plain and reviewed: what changed, the check and its result, open items; orchestrate: one line per slice, `<id>: pass|fail — <evidence pointer>`, then open items). Give more detail only when the user asks.
```

Add to `nudge.mjs` `lines`, after the fixed-order line (`:34`):

```js
"- output: write to the user in short bullets or keywords: the route on one line, one-line progress only when something changed, a final report of at most 15 lines (orchestrate: one line per slice, <id>: pass|fail — <evidence pointer>); more detail only when asked.",
```

### O-4: Most main-session output is hidden reasoning

- kind: behaviour-change
- severity: medium
- where: `.claude/agents/orchestrator.md:5` (`effort: high`, from `src/config.ts`)
- what happens today: the orchestrator runs on fable at `effort: high`. Its reasoning is billed as output but never shown.
- reproduction: M4: b34157a4 74.2% of 641,245 output tokens are neither visible text, briefs nor tool input (225 thinking blocks, all without text, so measured by subtraction); this run 88.3%.
- expected behaviour: owner's goal ("tokens should not be spent on prose nobody needs"). `CLAUDE.md` model policy: "Fable plans (orchestrator ...)"; `orchestrator.md:48` "Never lower it" applies to worker calls, not to the orchestrator's own default.
- fix scope: `src/config.ts` (orchestrator effort), then `npm run sync-agents` (`.claude/agents/orchestrator.md`), `dist/plugin`; benchmark arm before and after (`bench/matrix`), since planning quality is the risk.
- risk: lower effort can weaken plans and raise retries (M3: 9 of 26 slices retried already). Decide on a benchmark, not on this count.
- confidence: 55 (the split is an estimate: chars/4 for visible parts)

Proposed (to measure, not to ship unmeasured): in `src/config.ts` set the orchestrator's effort to `"medium"` in a bench arm and compare output tokens, review failures and retries per slice with the current `"high"`.

### O-5: Output style as a mechanism

- kind: improvement
- severity: medium
- where: `scripts/orchestrate.sh` (plain run for `ORCH_AGENT=none`), `package.json` script `plain`
- what happens today: no output style is shipped or set. Claude Code docs (https://code.claude.com/docs/en/output-styles, fetched 2026-11-16): built-in Concise: "Responses lead with the result and leave out preamble, narration, and recaps" (v2.1.237+); custom styles live in `.claude/output-styles` or a plugin's `output-styles/`; frontmatter `force-for-plugin`: "apply this style automatically whenever the plugin is enabled ... Overrides the user's `outputStyle` setting"; "Output styles apply to the main conversation and to a fork ... Other subagents run their own system prompt, so styles don't change how they respond." https://code.claude.com/docs/en/sub-agents: "a custom subagent's system prompt replaces the default Claude Code system prompt entirely, the same way `--system-prompt` does"; the page says nothing on output styles for an `--agent` main thread.
- reproduction: the two fetches above (WebFetch, read only).
- expected behaviour: owner's goal. A main-thread agent's honouring of `outputStyle` is undocumented, so the orchestrator's own body (O-1) is the dependable place; workers ignore styles by design.
- fix scope: plain sessions only: `package.json` `plain` -> `claude --settings '{"agent":"","outputStyle":"Concise"}'`; `scripts/orchestrate.sh` plain branch adds `"outputStyle":"Concise"` to the same `--settings` JSON (it already passes `{"agent":""}`; `HEADLESS_FLAGS` in `scripts/claude-update.mjs:36-39` already lists `--settings`); `src/orchestrate-sh.test.mjs:47` pins `'{"agent":""}'` and must change with it; `.claude/rules/agents.md` 1.4.4 "Default agent" names the same flag text. Do not use `force-for-plugin`: it overrides the person's own choice.
- risk: Concise "does the engineering work as thoroughly as in the Default style" per the docs; a person who set another style loses it in those launchers only.
- confidence: 60

```text
"plain": "claude --settings '{\"agent\":\"\",\"outputStyle\":\"Concise\"}'"
```

### O-6: Nudge context is long

- kind: improvement
- severity: medium
- where: `.claude/hooks/nudge.mjs:33`
- what happens today: the orchestrate line alone restates most of the route skill's `:37-45`; the whole context is 1,204 words, added at every SessionStart of a plugin session that is not the orchestrator. It is input (cached after the first request), not output, but it is prose the session carries all session.
- reproduction: M5 command -> 1204.
- expected behaviour: owner's goal; writing rule of a context pointer: state what the material is and when to reach it (the route skill holds the detail).
- fix scope: `nudge.mjs`, `src/contracts.test.ts` (the nudge assertions at `:86-105`, `:191-204`, `:224`, `:232-241`, `:268-275`, `:305-331` pin the orchestrate details in the nudge), `.claude/rules/agents.md` three-places rule (it says the three places "describe" the routes; a pointer would change that rule). Hence behaviour-change of the rule too; the owner decides.
- risk: a session that never runs the route skill would no longer see the orchestrate rules; today they are duplicated for that case.
- confidence: 60

```js
"- orchestrate: act as the orchestrator yourself, following the orchestrate branch of the orchestration:route skill exactly (briefs, plan review, reviews, retries, report).",
```

### O-7: Plan-check block messages name an environment switch

- kind: improvement
- severity: low
- where: `.claude/hooks/plan-check.mjs:850`, `:922`
- what happens today: `:850` ends "ORCH_ALLOW_BUILTINS=1 allows built-ins."; `:922` ends "ORCH_STALL_GATE=off turns this check off." Both go to the orchestrator as block reasons.
- reproduction: `grep -rn "ORCH_[A-Z_]*=[a-z0-9]*" .claude/hooks/*.mjs .claude/hooks/verify.sh` (non-comment message lines) -> only these two.
- expected behaviour: `.claude/rules/agents.md`: "Model-facing text (agent bodies, the skills, the nudge's context string) names gate reasons ... but never an environment switch: the orchestrator cannot set them, and naming them invites it to ask for one." The list names agent bodies, skills and nudge, not hook messages, so this is not a bug against the rule's letter.
- fix scope: `plan-check.mjs`; extend `src/contracts.test.ts:223` to run the plan check's blocks and assert no `ORCH_` name; `dist/plugin`.
- risk: none for gating; a maintainer reading the block loses the hint (it stays in the hook's comments and README).
- confidence: 75

Delete the two sentences "ORCH_ALLOW_BUILTINS=1 allows built-ins." and "ORCH_STALL_GATE=off turns this check off." from the message literals.

### O-8: Workflow logs the whole plan JSON and returns full gap texts

- kind: improvement
- severity: low
- where: `.claude/workflows/orchestrate.js:391`, `:719`, `:724-729`
- what happens today: `:391` `log(`plan: ${JSON.stringify({ constraints: ..., slices })}`)` prints every slice object and constraint text to the progress log; `:719` does it again after a replan; `:450`, `:483` log gap texts. The result (`:724-729`) returns `gaps` texts per slice, which the calling session then relays.
- reproduction: quoted lines; `src/workflow.test.mjs:318` reads only that a log starts with "plan after replan: ".
- expected behaviour: owner's goal; the `:389` line already gives ids.
- fix scope: `orchestrate.js` (log `plan: <n> slice(s), constraints C1-C<n>`; add `summary`, one string line per slice), `src/workflow.test.mjs:318` keeps its prefix; `dist/plugin/workflows/`.
- risk: the full plan JSON is the only plan record a person sees during a workflow run; keep it in the result instead of the log if wanted.
- confidence: 60

```js
log(`plan: ${slices.length} slice(s), constraints ${[...constraints.keys()].join(', ') || 'none'}`)
// result:
summary: results.map((r) => `${r.slice.id}: ${r.status} (${r.attempts} attempt${r.attempts === 1 ? '' : 's'})`).join('\n'),
```

### O-9: Headless runs print one JSON document to a terminal

- kind: behaviour-change
- severity: low
- where: `scripts/orchestrate.sh:179`, `scripts/auto.sh:81`
- what happens today: `printf '%s\n' "$out"` prints the reduced result (last `result` string plus `orch_totals`) as JSON; in a terminal the person reads the report as one escaped string. `auto.sh` already prints short `route:`/`review:` lines on stderr (`:59`, `:137`).
- reproduction: quoted lines.
- expected behaviour: owner's goal.
- fix scope: `scripts/orchestrate.sh` (when `[ -t 1 ]`, print the `result` text and one totals line, e.g. `turns 41, 12m 3s, exit 0`; piped, JSON as now, which `scripts/log-run.mjs` reads from `$out` and `bench/lib/native-launch.sh` reads from a pipe); `auto.sh` reads `session_out` through `$(...)` (not a terminal), so it keeps getting JSON; tests in `src/verify.test.ts` run without a terminal.
- risk: low; a person piping to `jq` is unaffected.
- confidence: 55

```bash
if [ -t 1 ]; then printf '%s' "$out" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const t=j.orch_totals||{};console.log(j.result??"");console.error(`turns ${t.turns??"?"}, ${Math.round((t.wall_ms??0)/1000)} s, exit ${t.exit_code??"?"}`)' || printf '%s\n' "$out"; else printf '%s\n' "$out"; fi
```

### O-10: `src/gate-hardening.test.mjs` sets the src suite's wall time

- kind: improvement
- severity: medium
- where: `src/gate-hardening.test.mjs:93`, `:151`, `:189`
- what happens today: the file's 21 tests run one after another (node --test parallelises files, not tests in a file) for 60.2 s; the src suite takes 61.0 s, so this file is its critical path. Slowest: `run_limited terminates the command before it kills it, and kills a group that ignores the terminate` 16.2 s (`:189`: two 4 s limits in sequence, then a 5 s kill grace); `test gate budget: no time left for the bugfix check blocks as unverified` 10.3 s (`:151`: a 5 s suite twice, the second run for a plain agent); `test gate: the loop guard still lets a hung suite's agent through after two blocks` 9.4 s (`:93`: three hung runs at a 1 s limit).
- reproduction: M6 command; durations 16179 ms, 10321 ms, 9372 ms in `check.log`.
- expected behaviour: brief, item 5 ("a way to shorten each without weakening what it checks").
- fix scope: test files only. (a) Split by the file's own sections (`:77` "1.", `:170` "1b.", `:289`-`:514` the rest) into `src/gate-hardening-time.test.mjs`, `-trap.test.mjs`, `-logs.test.mjs`, each importing `./test-tmp.mjs` first (`src/test-tmp.test.mjs` checks it); same assertions, run in parallel. (b) `:189`: run the polite and stubborn `run_limited` calls as two background jobs in the one bash script and `wait` (each still asserts its own timed-out flag, cleanup and kill): about 10 s instead of 16 s. (c) `:151`: give the plain-agent half its own fast suite (`tests/slow_test.sh` replaced by `true` in a fresh repo with the same `ORCH_HOOK_BUDGET_S`): it still shows a non-bugfix brief passes under the budget; about 5 s saved.
- risk: (a) more parallel bash processes can make the timing asserts flakier on a loaded machine; the file's comments note load sensitivity (`:180-183`).
- confidence: 70

### O-11: Two more clock waits

- kind: improvement
- severity: low
- where: `src/judge-hook.test.mjs:316` (setup `:60-78`); `bench/run.test.mjs:173`; `src/verify.test.ts:487`
- what happens today: the clamp test spawns the hook with `ORCH_JUDGE_TIMEOUT_MS=120000` and a stub that answers after 90 s, and waits for the real 45 s cut (39.7 s after load); it already runs beside the other tests (`:60` "The clamp test needs 45 s of wall time, so it starts now"), so it sets that file's 45.7 s, which matters once O-10 lands. `executeRun` (8.2 s) runs three fake agents in sequence, two of them to a 3 s deadline (`cap_min: 0.05`). The auto.sh verdict test (7.8 s) runs `auto.sh` six times with `spawnSync`.
- reproduction: M6 durations 39732 ms, 8176 ms, 7811 ms.
- expected behaviour: brief, item 5.
- fix scope: tests only. Judge: keep the unit asserts (`judgeTimeoutMs("120000") === 45000`) and run the end-to-end deny with `ORCH_JUDGE_TIMEOUT_MS=1500`, asserting `timed out after 1500 ms` and a decision before 10 s; add a static assert that `judge-hook.mjs` sets its deadline from `judgeTimeoutMs(process.env.ORCH_JUDGE_TIMEOUT_MS)` (`judge-hook.mjs:27`). This drops only the live 45 s case. Bench: run the `rate_limited` and `deadline` cases with `Promise.all` (distinct run ids, distinct output folders): about 3 s saved. auto.sh: run the six replies with async `spawn` and `Promise.all`.
- risk: the judge change trades a live check of the 45 s cap for a unit plus wiring check; keep the live case behind a slow-test marker if the owner wants it.
- confidence: 60

## Unproven

- Whether `outputStyle` applies to a session started with `--agent orchestrator`: the docs are silent (O-5); a probe needs a model call, which this slice may not make.
- Main-session reasoning tokens: thinking blocks carry no text, so M4's "rest" is output minus chars/4 estimates of the visible parts; the chars/4 ratio was not calibrated.
- Main-session cache reads: telemetry has no main-session records; not computed from transcripts.
- Plan-check appended blocks other than `HINT_INTRO` (read-router notes, skill facts, sources note): not reached, so their length is not measured.
- Whether O-1's contract changes plan or review quality: needs a bench run (model calls).
