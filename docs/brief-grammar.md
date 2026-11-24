# Brief and reply grammar

This page is the exact spec of three things. The first is the lines the orchestrator writes in its [briefs](glossary.md#b); the second, the lines [workers](glossary.md#w) write in their [replies](glossary.md#r). The third is the [run](glossary.md#r) model that the hooks and the [pane](glossary.md#p) compute from them. It is for maintainers who change a hook, a brief or the parser.

One implementation holds every rule: `.claude/hooks/brief.mjs` (ESM, Node built-ins only, no side effects at import). The pane mirrors it in `dashboard/register.tsx`. `src/fixtures/briefs/` has a fixture for every form, with its parse result in `expected.json`. `src/brief.test.mjs` checks the fixtures and each rule below, so the parser and the pane stay in step.

Two rules hold for every parser:

- It takes any value and never throws. Empty, malformed or non-string input gives `null`, `[]`, `{}` or `false`.
- Every line added after the first version is optional. A brief, plan or reply without a line parses exactly as before, with that field empty, and a check that needs the field skips. This covers `RISKY`, `CHECKS`, `REPLAN`, `CONSTRAINTS` and the plan slice lines; `SOURCES`, `READ`, `KIND`, `VALIDATE` and `SKILLS` in briefs; `GAP` and `QUOTE` in replies; the skill slice lines `SKILL`, `TARGET`, `UPDATE` and `DRAFTS` in briefs and planned slices; and `DRAFT`, `SKILLS-USED` and `SKILLS-SKIPPED` in replies.

## Lines at a glance

| Line | Where | Read by |
|---|---|---|
| `SLICE:`, `FILES:`, `DEPENDS:` | first lines of every implementer brief | plan check, journal, pane |
| `PATH: light`, `RISKY: yes`, `CHECKS: C1, C3` | implementer briefs | plan check, review gate (opus review, constraint answers) |
| `PLAN REVIEW`, `REPLAN: <n>`, `CONSTRAINTS:` block, per-slice `GOAL:` | the plan reviewer's brief | run model, `not_in_plan`, pane progress |
| `FOCUS:` | reviewer briefs | the reviewer |
| `KIND: bugfix` | implementer briefs | the implementer (it writes a failing reproduction test first); the bugfix check |
| `VALIDATE: gaps` | reviewer briefs | review counting |
| `SOURCES:`, `READ: lookup\|extract\|judge` | researcher briefs | read router |
| `SKILLS: <names>` | implementer, researcher and reviewer briefs; the orchestrator never writes it in the integrator's | the worker; skill suggestions |
| `KIND: skill`, `SKILL: <name>`, `TARGET:`, `UPDATE: yes`; `DRAFTS: <names>` | a skill slice's implementer brief; any worker brief | plan check (skill slices, [docs/skills.md](skills.md)), skill gate |
| `ORCHESTRATION: workflow` | briefs of the [gated workflow](glossary.md#g) | plan check and run model, which skip the brief |
| `STATUS:`, `C1: pass (cmd) ...`, `C1: pass (read) ...`, `C1: fail ...`, `OPEN:` | every reply | journal, review gate, pane |
| `GAP: <0-100> <text>` | reviewer replies | review counting, stall gate |
| `QUOTE: <locator> \| <verbatim text>` | researcher replies | quote check |
| `DRAFT: <name> <branch>` | a skill slice's reply | journal |
| `SKILLS-USED: <names>`, `SKILLS-SKIPPED: <names>` | worker replies whose brief named or suggested skills | journal, `npm run report` |

## Line rule

A field is a line `KEY: value`.

- Before the key, a line may carry list, quote and emphasis characters (`- `, `> `, `*`, `_`, backticks). After the colon it may carry `*`. So `- **SLICE:** s1` works.
- Keys are case-insensitive.
- For a header field, the first matching line anywhere in the brief wins. `plan-check.mjs` uses the same rule. So header lines go at the start of the brief, before any body text or quoted plan that could repeat a key.
- A key in the middle of a line does not count.

Lists (`FILES`, `DEPENDS`) are comma-separated. Each entry is trimmed and loses outer quotes or backticks and a leading `./`. Empty entries and `none` are dropped.

A slice id is the first word of the value, without quotes, backticks or `*`, with trailing `:,;.` removed. So `SLICE: "A1"` and `SLICE: A1.` are both `A1`. A brief's header and a plan's `SLICE:` lines use this one rule, so a slice is launched under the id it was planned with.

`CHECKS` keeps the `C<n>` tokens, upper-cased, deduplicated, in order.

## Implementer brief

```
SLICE: auth
FILES: src/auth.ts, src/session/
DEPENDS: A0, A1
PATH: light          (optional: the single-slice light path)
RISKY: yes           (optional: anything else, or no line, is not risky)
CHECKS: C1, C3       (optional: constraint ids this slice must satisfy)
```

- The plan check requires `SLICE`, `FILES` and `DEPENDS`.
- `PATH` is `light` when its value starts with the word `light`.
- A brief with a line `ORCHESTRATION: workflow` (the gated workflow) is skipped by the plan check and by the run model.

`parseHeader(text)` returns `{ slice, files, depends, path: 'light'|null, risky, checks, focus, workflow, sources, read, kind, validate, skills, skill, target, update, drafts }`. The last four are the skill slice fields ([Skill slice lines](#skill-slice-lines)).

<a id="optional-brief-lines-040"></a>

## Optional brief lines

Any brief (implementer, reviewer, researcher) may carry these header lines. All are optional, and they follow the [line rule](#line-rule).

What reads them:

- `VALIDATE: gaps` on a reviewer brief changes how its review counts ([Review counting](#review-counting)).
- `SOURCES` and `READ` on a researcher brief feed the read router; `SOURCES` also feeds the plan check's coverage note ([docs/gates.md](gates.md)).
- `KIND: bugfix` on an implementer brief turns on the bugfix check of the test gate ([docs/gates.md](gates.md)). Other `KIND` values have no gate behaviour, except `KIND: skill` ([Skill slice lines](#skill-slice-lines)).
- `SKILLS` is read by the worker ([below](#skills)).

```
SOURCES: docs/research.md, https://example.com/spec.html   (paths or URLs the worker should read)
READ: extract                                              (lookup, extract or judge: how the sources are read)
KIND: bugfix                                               (the kind of work: bugfix and skill have behaviour)
VALIDATE: gaps                                             (a validation review: re-check the listed gaps against the diff, keep only those that stand)
SKILLS: anthropic-skills:docx, orchestration:route         (skills the worker should load before it starts)
```

| Line | Field | Parse |
|---|---|---|
| `SOURCES: <list>` | `sources: string[]` | comma-separated, read like `FILES`: trimmed, outer quotes or backticks and a leading `./` removed, empty entries and `none` dropped |
| `READ: <mode>` | `read: 'lookup'\|'extract'\|'judge'\|null` | the first word of the value (quotes, backticks, `*`, `_` and trailing `.,;:!?` removed), case-insensitive; any other word, or no line, is `null` |
| `KIND: <kind>` | `kind: string\|null` | the first word, cleaned the same way, lower-cased (`KIND: Bugfix: crash` gives `bugfix`); empty or no line is `null` |
| `VALIDATE: gaps` | `validate: boolean` | `true` only when the first word is `gaps` (any case); anything else is `false` |
| `SKILLS: <names>` | `skills: string[]` | comma-separated, read like `FILES`; an entry that is not a skill name is dropped; duplicates dropped keeping the first; at most 8 names, the first 8 kept |

### SKILLS

`SKILLS` is optional on an implementer, reviewer or researcher brief. The orchestrator never writes it in the integrator's brief; the parser still reads the line wherever it stands.

- The orchestrator writes it to name the skills the worker should load with its Skill tool before it starts. Example: a file-format skill for a document slice.
- A skill name is a letter or digit, then letters, digits, `_`, `.`, `/` or `-`. It may be namespaced with `:` parts of the same form (`docx`, `anthropic-skills:docx`, `orchestration:route`, `a:b:c`). It has at most 100 characters.
- Anything else is dropped: a phrase such as `use the pdf skill`, `:x`, `x:`. So the field never carries brief text.
- No gate reads it. The plan check may add [skill suggestions](glossary.md#s) of its own ([docs/skills.md](skills.md)). A brief without the line has `skills: []`.

## Skill slice lines

A [skill slice](glossary.md#s) is an implementer slice that drafts one new skill, or changes one, in a skills repository instead of the project. Its brief carries `KIND: skill` and the optional header lines below. Any implementer, researcher or reviewer brief may carry `DRAFTS:`. They follow the [line rule](#line-rule). `SKILL:` is not `SKILLS:`.

```
SLICE: notes-skill
FILES: skills/release-notes/, README.md     (relative to the skills repository root, not the project)
DEPENDS: none
KIND: skill
SKILL: release-notes                        (the skill's name: its folder skills/<name>)
TARGET: public                              (optional: private, the default, or public)
UPDATE: yes                                 (optional: the skill exists and this slice changes it)
DRAFTS: release-notes                       (any worker brief: drafts of this run to read first)
```

| Line | Field | Parse |
|---|---|---|
| `SKILL: <name>` | `skill: string\|null` | the first word, quotes, backticks and `*` removed; kept only when it is lower-case letters and digits in words joined by single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`) and at most 64 characters, else `null` (`Release_Notes`, `-x`, `a--b` are `null`) |
| `TARGET: private\|public` | `target: 'private'\|'public'\|null` | the first word, cleaned like `KIND`, any case; any other word, or no line, is `null` (the plan check then uses private) |
| `UPDATE: yes` | `update: boolean` | `true` when the value starts with `yes` (like `RISKY`) |
| `DRAFTS: <names>` | `drafts: string[]` | comma-separated, read like `FILES`; only names valid for `SKILL` are kept; duplicates dropped keeping the first; at most 8 |

`isSkillName(name)` is the `SKILL` rule. A brief without these lines parses exactly as before, with `skill: null`, `target: null`, `update: false`, `drafts: []`. Its launch record has none of the four fields: they are written only when set.

**Plan check.** The plan check's five checks of a `KIND: skill` brief, their reasons and the facts block it appends are in [docs/skills.md, What the plan check does](skills.md#what-the-plan-check-does). What it does with these lines:

- The slice's `FILES` resolve against its draft worktree, `<config dir>/orchestration/skill-drafts/<target>/<name>`. The config dir is `CLAUDE_CONFIG_DIR` or `~/.claude`. This holds in the launch, and for the same slice in the plan. So skill slice files never overlap a project slice's files.
- A brief with `DRAFTS:` gets one line per draft of this run that the plan check allowed: the path of its `SKILL.md`. Other names are dropped.
- Decisions go to `skill-create.jsonl` (parsed fields and paths only).

**URLs in a brief.** `briefUrls(text)` returns the `http://` and `https://` URLs anywhere in the text, header or body.

- They are unique (exact string), in order of first appearance, at most 50.
- A URL ends at whitespace, `<`, `>`, a quote or a backtick. Trailing `).,;:'"]>` characters are then stripped, except a `)` or `]` that closes one opened inside the URL. So `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its `)`.
- A scheme with no host (`https://`, `https://?x`) is not a URL.

## PLAN REVIEW brief

The brief starts with `PLAN REVIEW` (leading whitespace allowed, upper case). It is the brief of the reviewer that does the [plan review](glossary.md#p). Its journal slice is `plan`.

```
PLAN REVIEW
REPLAN: 1                      (optional: extends the open run)
CONSTRAINTS:
C1: parsing never throws on malformed input
C2: no new dependencies
SLICE: toml
FILES: toolkit/toml.py, tests/test_toml.py
DEPENDS: none
GOAL: TOML reader
CHECKS: C1, C2
SKILLS: tdd                    (optional: the slice's skill decision)
SLICE: csv - CSV reader        (text after the id is the goal)
FILES: toolkit/csv.py
DEPENDS: toml
RISKY: yes
CHECKS: C2
SKILLS: none                   (a RISKY slice always carries SKILLS: <names> or SKILLS: none)
```

- **`REPLAN: <n>`.** The leading integer of the value, after emphasis. So `2 (second)` is 2, and `1a` or `1.5` is 1. A value that does not start with digits is `null`.
- **Constraints block.** A line `CONSTRAINTS:`, then lines `C<n>: <text>`. Prefix characters and blank lines inside the block are allowed. The first line that is neither ends the block. Ids are upper-cased. A repeated id keeps its first text. An empty text is dropped.
- **Planned slices.** Each `SLICE:` line starts a slice; here a `#` heading prefix is also allowed. The `FILES`, `DEPENDS`, `GOAL`, `RISKY`, `CHECKS`, `KIND`, `SKILL` and `TARGET` lines up to the next `SLICE:` fill it.
  - `KIND`, `SKILL` and `TARGET` read as in a brief. A skill slice in the plan carries `KIND: skill` and `SKILL: <name>`, and its `FILES` are relative to the skills repository.
  - The id follows the slice id rule of the [line rule](#line-rule) (quotes allowed, trailing `:,;.` removed). The id `plan` is not a slice.
  - Text after the id is the goal; otherwise the first `GOAL:` line.
  - A repeated id continues its first entry. This matches `planOf` in `dashboard/register.tsx`.
- **`SKILLS:` in a planned slice.** The slice's skill decision: `SKILLS: <names>` (the skills its workers will get on their `SKILLS:` lines, each name as the Skill tool lists it) or `SKILLS: none`.
  - Optional on a slice. A RISKY slice always carries one of the two.
  - The plan reviewer checks the choice. These are gaps: a named skill that is not installed or does not fit the slice, and a RISKY slice with no `SKILLS:` line.
  - `parsePlan` does not read it, and no gate does. In a PLAN REVIEW brief the plan check counts only a `SKILLS:` line before the first `SLICE:` line, as names for the plan reviewer itself.
- **Not a plan.** Text that does not start with `PLAN REVIEW` is not a plan: `parsePlan` returns `{ isPlanReview: false, replan: null, constraints: {}, slices: [] }`. A plan review without slice lines has `slices: []`.

`parsePlan(text)` returns `{ isPlanReview, replan, constraints: { C1: text }, slices: [{ slice, files, depends, goal, risky, checks, kind, skill, target }] }`. A slice without the last three lines has them `null`.

**Plan review and the light path.** Implementers of a planned run wait until its plan reviewer has stopped (`no_plan_review`). `PATH: light` skips that wait only for a run's single slice. The plan check blocks a light brief with `light_path_multi` once another slice ran in scope, and also while the open run is a planned run whose plan names more than one slice. Its message then names the planned slices. Both reasons share one loop guard: two blocks, then `no_plan_review_gave_up`.

## Reviewer brief

```
SLICE: toml
FOCUS: the error path on malformed input   (optional, for the reviewer only)
CHECKS: C1, C2                             (optional: answer one line per id)
```

Parsed by `parseHeader` (`focus`, `checks`).

**Test gate pending line (1.6.1).** The plan check may append one line to a slice reviewer's brief (never a PLAN REVIEW): `Test gate (added by the plan check): the test gate has not reported yet on this slice's latest implementer stop, ...`. It appears only while the slice's latest implementer has stopped and no test-gate record is paired with that stop: none was logged yet, or since 2.0.0 the pairing (`stopGateOf` in `run.mjs`) cannot tie one to it. It means the tests may still fail: the reviewer runs the acceptance check itself, does not rest a pass on the tests having passed, and says in its report that the gate had not reported. Since 2.0.1 the line appears only while the gate may still be running (the stop is younger than `stopGateWindowMs` in `run.mjs`, 600 s by default); past that, or when the stop's record is `test_gate_error`, the plan check appends the no-result line instead, `Test gate (added by the plan check): the test gate left no result that can be tied to this slice's latest implementer stop, and it is no longer running, ...`, with the same instruction. Neither line parses as a brief or reply line. While that implementer has a failed-tests block it never saw, the plan check refuses the reviewer instead (`tests_failed_after_report`, [gates.md, Plan check](gates.md#plan-check)).

## Reply

```
STATUS: pass
C1: pass (cmd) npm test -> 42 pass, 0 fail
C2: pass (read) package.json:12
C3: fail parse('[') throws SyntaxError
OPEN: none
```

### STATUS rule

One rule, `parseStatus`, used by the journal, telemetry and the review gate. The pane uses its mirror in `dashboard/register.tsx`, and `scripts/auto.sh`'s reviewed route applies the same rule in its own code.

- A STATUS line starts with `STATUS: pass` or `STATUS: fail`, after whitespace, emphasis or heading characters (`**STATUS: pass**`, `## STATUS: fail`).
- These are not STATUS lines: a blockquoted line (`> STATUS: pass` is a quote), a STATUS in the middle of a line, and the template `STATUS: pass or fail`.
- Any STATUS line that says fail fails the reply. Otherwise the first one decides.
- No STATUS line is no status (`null`). For the review gate a review with no status neither passes nor fails: it blocks with `last_reviewer_no_status`. The reviewed route of `scripts/auto.sh` counts no STATUS line as a fail.

### OPEN

The first non-quoted `OPEN:` line.

- Its inline value is one item. The list lines right below it (`-`, `*`, `+`, `1.`) are one item each, up to a blank line after an item or the first line that is not a list line.
- These mean nothing open: empty, `none`, `-`, `n/a` and `nothing`. Case does not matter; a trailing `.` and surrounding emphasis or backticks are allowed (`**OPEN: none**`, `OPEN: _none_`, `` OPEN: `none` ``).
- Anything else is an item: `OPEN: none (a note)` is one.

### Answers

One line per checked id, not quoted:

| Form | Meaning |
|---|---|
| `C1: pass (cmd) <command> -> <result>` | ran a command; `→` is accepted and read as `->` |
| `C1: pass (read) <file:line or URL>` | checked by reading |
| `C1: fail <reason>` | not met |

Ids are upper-cased. The first line for an id decides, except that a later `fail` line for it overrides a pass. The template `C1: pass or fail` is not an answer.

### Gaps and quotes

Optional. A reviewer may list each gap it found with its confidence. A researcher may back a claim with a verbatim quote:

```
GAP: 80 no test for the empty-input path
GAP: 35% the error message is unclear
QUOTE: docs/spec.md:12 | "the parser never throws"
QUOTE: papers/b.pdf p.4 | the exact sentence
```

Like STATUS, OPEN and the answers, these are the worker's own lines. List and emphasis characters may come before the key (`- GAP:`, `**QUOTE:**`). A blockquoted line (`> GAP: ...`) and a key in mid-line do not count. Every such line counts, in order.

- **`GAP: <0-100> <text>`.** The number may carry a trailing `%`.
  - A number from 0 to 100 gives `{ confidence: <n>, text }`.
  - A missing number, a number above 100, a negative or a decimal one gives `{ confidence: null, text: <the whole rest> }`.
  - Trailing emphasis characters are removed from the text.
  - A GAP line with no text (`GAP:`, `GAP: 70`) and the template `GAP: <0-100> <text>` are dropped.
- **`QUOTE: <locator> | <verbatim text>`.** The locator is the part before the first `|`: a path, `path:line` or `path p.N`, with surrounding backticks removed. The text is the part after it, trimmed, with one pair of surrounding quotes stripped (`"…"`, `'…'`, `“…”`, `‘…’` or backticks). A line without `|`, or with an empty locator or text, is dropped.

### Draft

Optional, for skill slices. A skill slice reports no `BRANCH:` line; it names its draft instead:

```
DRAFT: release-notes skill/release-notes
```

- `DRAFT: <name> <branch>` has exactly two words, with backticks and emphasis around them removed.
- The name must be valid for `SKILL`.
- The branch is a plain branch name: letters, digits, `.`, `_`, `/`, `-`, starting with a letter or digit, no `..`, not ending in `/` or `.lock`, at most 200 characters.
- The first valid such line counts. Invalid ones are skipped. A blockquoted line or a key in mid-line does not count.
- `DRAFTS:` is a brief line, not this one.

### Skills used and skipped

Optional, any worker. A worker whose brief named skills, or got suggestions, ends its reply with the skills it loaded and the ones it left out:

```
SKILLS-USED: frontend-design, anthropic-skills:docx
SKILLS-SKIPPED: diagnosing-bugs (no bug in this slice)
```

- The first `SKILLS-USED:` line and the first `SKILLS-SKIPPED:` line count. A blockquoted line or a key in mid-line does not. `SKILLS:` is a brief line, not one of these.
- Each value is read like `SKILLS`: comma-separated, trailing emphasis removed.
- Each entry is cut at a trailing reason: a space and then `(`, `-` and a space, an en or em dash, or `: `.
- Backticks and quotes are removed. Entries that are not a skill name are dropped (`none` included). Duplicates are dropped, keeping the first. At most 8.

### Parse results

`parseReply(text)` returns `{ status, open: string[], answers: { C1: { verdict: 'pass'|'fail', mode: 'cmd'|'read'|null, detail } }, gaps: [{ confidence: number|null, text }], quotes: [{ locator, text }], draft: { name, branch }|null, skillsUsed: string[], skillsSkipped: string[] }`. `parseStatus(text)` returns the status alone. GAP, QUOTE, DRAFT and SKILLS-* lines never change the status, the answers or OPEN.

## Run model

A run belongs to one session. It is computed only from the [log records](#log-records), which hold no raw prompt or reply.

`foldRuns({ launches, stops, gates, starts }, { now, staleMin, sessionId })` merges the four inputs into one timeline ([Ordering](#log-records)).

"Passed" and "failed" in this section, and in the gates, mean a review's counted status ([Review counting](#review-counting)), not its raw STATUS.

### Opening a run

- A PLAN REVIEW launch record (reviewer, `isPlanReview`) without `replan` opens a planned run. It closes any run open in the session.
- A light-path implementer launch (`path: "light"`) opens a light run when no run is open.
- A PLAN REVIEW with `replan` extends the open run with its `plan.slices` and `plan.constraints`. With no run open, it opens one.
- Other implementer launches join the open run. With none open, they are not tracked.
- Launches with `workflow: true` are skipped.
- A new user prompt does not close a run.

### Carried slices

When a PLAN REVIEW without `replan` closes an open run, each slice that its plan names again, and that the closed run holds, is handed on by its state there. The plan's lines are then merged in, as for any planned slice.

| Slice in the closed run | In the new run |
|---|---|
| Not final, has an implementer launch or stop, and its latest review after that (if any) does not count as a fail | Moves in whole: its launches, attempts and reviews leave the closed run. Its later stops and reviews meet its attempt in the new run. This covers an attempt with no review yet, a pass still waiting for its [opus review](glossary.md#o), and a review with no STATUS. |
| Final and passed | Counts as final and passed (`carriedFinal`), so it does not keep the new run open. |
| Latest review counts as a fail, or failed for good | Starts clean. Its failed attempt stays in the closed run ([Stall](#stall)). |
| Not named by the new plan | Stays in the closed run. |

A carried final slice keeps `carriedFinal` until one of these happens:

- An implementer of it works in the new run: a launch, or an implementer stop record. A `SendMessage` resume makes a stop and no launch. That activity starts it clean; its attempts and reviews from then on decide it.
- A review of it in the new run counts as a fail. This ends the carried state the same way, with no implementer in between. From then on it is judged like any slice of the run: it is neither passed nor final (its failed review is its latest, so a retry is due), and the run stays open. A run that had already closed stays closed ([Closed run](#closed-run)).

A passing review, a fail that counts as a pass, and a reply with no STATUS leave it final.

The review gate gates a slice only where it has an implementer attempt. So it does not block on a carried slice until an implementer of it works in the new run.

The pane mirrors this rule in its run marks (`carry`, `done`).

### Attempts

A retry may be a fresh implementer launch or a `SendMessage` resume of the same worker, which makes no launch. So a slice's attempts are counted from its implementer stop records (the slice is joined by `agent_id`), fresh launches and resumes alike.

Stops with no review of the slice between them count as one attempt. A test-gate block makes the worker stop again. An implementer woken after its delivered report that only writes text and stops again gets no stop record (2.0.1, [Continued stops](#continued-stops)), so it adds no attempt; with a tool call since its previous stop, or headless with no transcript, it is recorded and counts.

### Final slice

A slice is final in either of these cases:

1. **Failed for good.** Its latest review (a reviewer stop after the slice's latest implementer launch or stop) failed after 3 implementer attempts in the run (`MAX_RETRIES` 2).
2. **Passed, with the opus review rule met.** Its latest review passed. Either the slice has no [doubt signal](#doubt-signals) (none when `ORCH_ESCALATION=off`), or a review after its latest implementer launch or stop passed on opus (`hasOpusPass`).

For a slice under the [second review rule](#second-review-counting) (2.1.0) "its latest review" in both cases reads as the verdict of the reviews that count: failed for good when any of them counts as a fail after 3 attempts; passed when two passes come from two different reviewer agents and none fails, with the opus rule read over those reviews.

More rules:

- Under `ORCH_ESCALATION=always` every slice carries the signal `always`, so it needs that opus pass.
- A slice whose latest review passed but which still needs its opus pass is not final. It keeps `passed`, the latest review's counted status.
- The fold computes the signals as each record arrives (`settle`, with the `env` passed to `foldRuns`), from the same inputs as `doubtSignals`.
- A review with no STATUS is neither a pass nor a fail.
- A slice under the second review rule with one pass, or passes from one agent only, is neither passed nor final, so its run stays open.

### Closed run

A planned run closes when every planned slice is final. A light run closes when its slice is final.

- So a counted pass that still needs an opus pass leaves the run open. The opus review, and a further implementer launch of the slice (a light launch included), join that run instead of opening a new one.
- A closed run never reopens.
- A run waiting for an opus review that never comes does not stay open forever. After `ORCH_RUN_STALE_MIN` idle minutes it is stale ([Stale run](#stale-run)), which the plan check treats as closed.
- This includes a slice whose opus review the review gate gave up on (`opus_review_required_gave_up`), or that the person moved on from without one. The fold never sees that give-up: the record names no slice, and `foldRuns` reads only test-gate records. So the slice stays not final and its run stays open until it goes stale.
- Until then, a new light task is blocked with `light_path_multi` and an unplanned implementer with `not_in_plan`, each at most twice before the plan check gives up.

### Stale run

A run is stale when nothing of it is running and no launch, stop or agent start happened in it for `ORCH_RUN_STALE_MIN` minutes (default 30).

- Running agents come from the `starts` input: the telemetry.jsonl SubagentStart and SubagentStop records, which every agent emits. An agent runs from its SubagentStart to its next SubagentStop, or journal stop record, with the same `agent_id`. A resumed agent starts again under its id.
- A start belongs to the open run. A start after the run was idle for the threshold marks it stale instead of reviving it.
- So a long foreground worker, whose launch record is written only when it ends, never makes its run look idle.
- Without `starts`, staleness depends on launches and stops alone.
- A lost SubagentStop keeps the run from going stale until a new PLAN REVIEW closes it or the session ends. The review gate's own running check ignores starts older than the threshold.
- The plan check treats a stale run as closed, so a light launch opens a new run. The review gate keeps gating its unreviewed slices.
- A stop that arrives later (a long worker) still lands in the latest run that has its slice.

<a id="review-counting-040"></a>

### Review counting

Each review in a slice state keeps the reviewer's own `status` and adds a counted status, `counted`. Slice finality, `doubtSignals`, `hasOpusPass` and the gates use the counted status (`countedStatus(review)`).

**Gap cutoff.** `ORCH_GAP_MIN` is an integer from 0 to 100, default 80. Any other value (empty, negative, above 100, a decimal, text) is 80.

A review with STATUS fail counts as a fail when its stop record has any of:

- a gap with confidence at or above the cutoff;
- a gap with a null confidence (counted as 100, as the gated workflow does);
- an answer with verdict fail;
- no gaps at all (an old-style reply, or a record from before gaps were logged, without `gaps`).

Otherwise, a fail whose gaps are all below the cutoff counts as a pass and sets `lowConfidence`. It adds the doubt signal `low_confidence_fail`, so the opus review rule applies. An opus reviewer's low-confidence fail counts as an opus pass. Since 2.1.0 the gated workflow treats such a fail the same way in its own code: a slice that is not risky gets an opus review before it is accepted.

`ORCH_GAP_MIN=0` makes every fail count. A pass stays a pass, and a reply without STATUS stays `null`, whatever its gaps.

**VALIDATE supersede.** `VALIDATE: gaps` marks a validation review. The reviewer re-checks, against the diff, the gaps an earlier review of the attempt listed, and reports only the ones that stand.

- A review whose launch record has `validate: true` (that line in the reviewer's brief) supersedes the earlier reviews of the same slice made since the slice's latest implementer launch or stop.
- Those get `superseded: true` and `counted: null`. They count neither as a pass nor as a fail: no `retry` signal, no part of a stalled slice.
- Reviews of an earlier attempt are not touched.
- A validation reply with no STATUS supersedes nothing: it has no verdict to put in their place.

<a id="second-review-counting"></a>

**Second review counting (2.1.0).** A slice needs two reviews (`reviewsNeeded` 2) when its latest implementer launch record carries `reviews_needed` and the slice is RISKY (that brief, or its planned slice). The journal writes the field on this plugin's implementer launches only: 2 for a `RISKY: yes` brief, otherwise 1, and none with `ORCH_SECOND_REVIEW=off`. A slice without the field, or with an unreadable `handbacks.jsonl` (the `handbacks` input is `null`), needs one review and folds exactly as before.

- **The boundary.** Each implementer stop sets the attempt's `handbackAt`: the time of the agent's latest capture in `handbacks.jsonl` at or before the stop, after its latest start and after the slice's previous implementer event. Without one the boundary is the stop itself (`lastImplAt`).
- **When a review began** (`began`): the reviewer's latest SubagentStart at or before its stop (its resume, when it was resumed), else its launch record's time, no later than the stop. A review that began at or before the boundary is `early`: it counts neither as a pass nor as a fail.
- **The reviews that count** (`countingReviews`): those of the latest attempt (`currentReviews`) that are not superseded, have a counted status and are not early.
- **The verdict** (`secondReviewVerdict`, kept as `secondReview`): `fail` when any counting review counts as a fail, whatever the order; `pass` when none does and two passes come from two different reviewer agents (a resumed reviewer is one agent; a review with no agent id counts as one unknown agent); `one` with passes from one agent only; `null` with none. `passed`, `gaveUp`, `final`, the stall and the review gate read it.
- **A validation.** A VALIDATE review's pass counts as one of the two. It also supersedes the earlier reviews of the attempt, an earlier pass included, so after a validation that confirms no gap one more reviewer is needed.
- **Doubt signals and opus.** `doubtSignals` reads every counting pass (not only the latest) for `read_answer` and `open_items`, and `hasOpusPass` looks among the counting reviews. A RISKY slice carries `risky`, so one of the two passes must be on opus.
- **Stall.** An attempt failed when any of its counting reviews failed; the latest attempt with such reviews and the one before it stall when their failing reviews share a key. Two failing reviews of one attempt still never stall on their own.

**Keys.** A counted fail keeps `keys`: the [gap keys](glossary.md#g) of its gaps at or above the cutoff (null confidence included), deduplicated. Every other review has `keys: []`.

<a id="stall-040"></a>

### Stall

A slice is a **[stalled slice](glossary.md#s)** when a retry failed on the same gap again. All of these hold:

1. It is not final.
2. Its latest review with a counted status (pass or fail) is a counted fail.
3. The latest counted review of an earlier implementer attempt is a counted fail too. "Earlier attempt" means an implementer launch or stop lies between the two. Each review keeps `implAt`, the slice's latest implementer launch or stop when the review arrived.
4. Every counted review between them is a fail: no counted pass lies between them.
5. The two share at least one key.
6. No REPLAN plan review of the run (a PLAN REVIEW launch with `replan`) has finished after the later of the two. Finished means its reviewer stopped.

More rules:

- A REPLAN still running keeps the slice stalled. A REPLAN that finished after the slice stalled clears it, even when it was launched before.
- The REPLAN need not name the stalled slice, since replacement slices get new ids.
- Two failing reviews of one attempt (a second opinion) never stall a slice on their own. A second opinion after the retry keeps comparing the latest fail with the earlier attempt's.
- A plain PLAN REVIEW opens a new run, where the slice starts with no reviews.
- A slice that failed for good (3 attempts) is final, so never stalled. Three attempts still end as `slice_failed_for_good`; the stalled-slice rule only adds the earlier, same-gap case.
- The fold reports a stalled slice whatever `ORCH_STALL_GATE` says. The gates read the switch.

Slice states also carry:

- `countedFails`: reviews counted as fails;
- `stalled`, `stalledAt` (the second fail's time, or `null`) and `stallKeys` (the shared keys);
- `signals`: `doubtSignals` with the `env` passed to `foldRuns`.

Each run carries `replans`: the times the reviewers of its REPLAN plan reviews stopped.

## Reviewer model

The model of a reviewer launch is found in this order:

1. `tool_input.model`, when given;
2. the `model:` line in the frontmatter of the agent definition: project `.claude/agents/<bare name>.md`, else `${CLAUDE_PLUGIN_ROOT}/agents/<bare name>.md`;
3. otherwise unknown, which is not opus.

A model counts as opus when its name contains `opus`, `fable` or `mythos`, in any case: opus or a stronger tier. The function and the gate reason keep their names. Functions: `agentModel(toolInput, { projectDir, pluginRoot })` and `isOpusModel(model)`.

## Doubt signals

A slice needs a passing opus review after its latest implementer launch when any of these holds. `doubtSignals(slice, env)` returns their names; `hasOpusPass(slice)` says whether such a review exists.

| Signal | When |
|---|---|
| `risky` | `RISKY: yes` on its planned slice or its implementer brief |
| `retry` | the slice already had a review counted as a fail |
| `read_answer` | its latest review counted as a pass answered a constraint with `(read)` |
| `open_items` | its latest review counted as a pass has a non-empty OPEN |
| `tests_failed_isolated` | a test-gate record `tests_failed_isolated` (joined by `agent_id`) belongs to its latest attempt: it is later than the review the attempt followed. This includes a record with `not_run: 1`, which the test gate logs in an isolated worktree when the project's suite lock stayed held until too little time was left, so the tests did not run ([docs/gates.md](gates.md)) |
| `test_gate_gave_up` | a test-gate record that gave up (gate `test`, reason `max_blocks_reached` or `bugfix_unverified_gave_up`; joined by `agent_id`) belongs to its latest attempt, as above: the attempt's tests were not shown to pass. Since 2.0.0 the pane reads the last MiB of each `gates.jsonl` and marks both signals (`⚠isolated`, `⚠gate gave up`) |
| `low_confidence_fail` | a review after its latest implementer launch or stop reported fail but counts as a pass, because every gap was below `ORCH_GAP_MIN` (and not superseded) |

`ORCH_ESCALATION=off` turns the signals off. `ORCH_ESCALATION=always` requires an opus review for every slice (signal `always`).

## Log records

The run-model logs (`journal-launches.jsonl`, `journal.jsonl`, `journal-pending.jsonl`, `gates.jsonl`, `handbacks.jsonl`) hold parsed fields only, never brief or reply text. `telemetry.jsonl` is not one of them: it keeps the hook payload's strings clipped to 300 characters; since 2.0.1 without `last_assistant_message` (the worker's reply), which records written before then still hold. Readers accept older records that lack newer fields; those fold to empty values.

### Launch record

Written to `journal-launches.jsonl` by `journal.mjs` at PostToolUse on `Agent|Task`, for every launch of an implementer, reviewer, researcher or integrator. Built by `launchRecord(tool_input, { ts, sessionId, agentId, projectDir, pluginRoot, env })`.

| Field | Value |
|---|---|
| `ts`, `session_id` | the time and the session |
| `agent_id` | from the tool response when present, else `null`. A background launch returns `agentId`; a foreground result may carry it only in its text, as `journal.mjs`'s `agentIdOf` reads it |
| `agent_type` | bare role (`implementer`, not `orchestration:implementer`); older records have `role` |
| `slice` | `sliceOfBrief`: `plan` for a PLAN REVIEW brief, else the SLICE id, else `null` |
| `files`, `depends`, `path`, `risky`, `checks`, `focus`, `workflow` | `parseHeader` |
| `model` | `agentModel` ([Reviewer model](#reviewer-model)) |
| `isPlanReview`, `replan` | `parsePlan` |
| `plan` | PLAN REVIEW briefs only: `{ constraints, slices }` from `parsePlan` |
| `read`, `kind`, `validate` | `parseHeader` |
| `skills` | `parseHeader`'s `skills`: skill names only |
| `skill`, `target`, `update`, `drafts` | `parseHeader`'s skill slice fields, each present only when set (a valid `SKILL`, a `TARGET`, `UPDATE: yes`, `DRAFTS` names) |
| `sources` | `parseHeader`'s `sources`, with each `http://` or `https://` entry replaced by its host (`new URL(u).host`, port included; an entry that does not parse is dropped); paths stay as they are |
| `reviews_needed` | 2.1.0, this plugin's implementer only (bare or `orchestration:`, not a workflow brief): 2 when the brief says `RISKY: yes`, else 1; left out when `ORCH_SECOND_REVIEW` (the `env` in `ctx`) is `off` ([Second review counting](#second-review-counting)) |
| `urls` | the hosts of `briefUrls` of the prompt (`new URL(u).host`), deduplicated, in order of first appearance; invalid URLs skipped |

The record keeps hosts only, never a URL's path, query or fragment, which can carry tokens. `parseHeader` and `briefUrls` still return the full text, for hooks that read the brief directly.

### Stop record

Written to `journal.jsonl` at SubagentStop by `stopRecord({ ts, sessionId, agentId, role, slice, reply, status, run, filesTouched })`.

| Field | Value |
|---|---|
| `ts`, `session_id`, `agent_id` | the time, the session and the worker |
| `role` | bare; readers also accept `agent_type` |
| `slice` | from the launch record with the same `agent_id`, or through `journal-pending.jsonl` when the stop arrives before its launch |
| `status` | `parseStatus` of the final reply, or the status of the hand-back capture `journal.mjs` takes; `null` for a refused last hand-back (below) |
| `answers`, `open` | `parseReply` |
| `run` | the id `foldRuns` gives the run at write time; runs are numbered 1, 2, ... in session order |
| `model` | a reviewer stop may carry it; otherwise the model comes from its launch record |
| `continues` | `true`, only when set ([below](#continued-stops)) |
| `after_handback` | added by `journal.mjs`: the `tool_use_id` of the hand-back the stop follows, when there is one since the agent's latest start |
| `report`, `refused_by` | added by `journal.mjs` (2.0.0) only when the agent's latest hand-back since its previous stop record was refused and the stop's last message has no STATUS line: `report: "handback_refused"`, `refused_by` the refusing check (`handback`, `quote` or `test`), with `status` null ([logs.md, Hand-back capture](logs.md#hand-back-capture)) |

A resumed worker keeps its `agent_id`, so its stops join the same launch.

These fields are never text; no gap or quote text is ever stored:

| Field | Value |
|---|---|
| `gaps` | `[{ confidence, key }]`, one per GAP line of the reply, in order. `key` is `gapKey(text)`: the first 8 hex characters of the sha1 (`node:crypto`) of the gap text normalised: lower-cased, every run of non-alphanumerics (`[^a-z0-9]`) turned into one space, trimmed, cut to its first 120 characters. Equal keys mean the same gap across replies. |
| `quotes` | the number of QUOTE lines |
| `files_touched` | `string[]`, present only when the caller passes `filesTouched` as an array of strings (an empty array included); any other value leaves the field out |
| `draft` | `{ name, branch }` from the reply's DRAFT line, present only when the reply has a valid one; a reply without it gives the record it gave before |
| `skills_used`, `skills_skipped` | `string[]`, the `skillsUsed` and `skillsSkipped` of the reply, each present only when non-empty; a reply without the lines gives the record it gave before. `npm run report` counts them in its Skills section |

Older records lack these fields, and readers treat a missing field as empty. `foldRuns` reads `gaps` for review counting and for stalled slices, and the reviewer launch record's `validate` for supersede. A stop record without `gaps` is an old-style reply, whose fail counts. So records without these fields fold and gate exactly as before.

#### Continued stops

`continues: true` means two things held: the SubagentStop payload had `stop_hook_active` true, and the worker already has a stop record in the session since its latest SubagentStart (2.0.1; a record from before a `SendMessage` resume does not count). So the stop ends the same turn as that earlier one: the stop after a forced hand-back, or after a test-gate block.

- In the fold, a reviewer's continued stop replaces the same worker's latest review of the slice. So one review recorded twice counts once. When that review is the slice's latest and no implementer launch or stop came after it, it is replaced at the end; otherwise (2.0.1) it is replaced where it stands and keeps its `ts` and `implAt`, so it stays a review of the attempt it read and never becomes a review of a later attempt.
- A `SendMessage` resume (`stop_hook_active` false) is a new review. The journal knows a resume by the coordinator's message in the transcript after the previous stop record, and takes the report only from the turns after it.
- A woken stop (2.0.1) is no review at all: a reviewer woken after its delivered report (a late shell task, a prompt) that stops with `stop_hook_active` false, no hand-back since its previous stop record, no STATUS line in its last message and no resume message gets no stop record. An implementer's such stop gets none either when its transcript shows no tool call since the previous stop ([logs.md, Journal](logs.md#journal)).
- `npm run report` counts a continued record's skills in place of the earlier record's.
- Records without the field fold as before.

### Test-gate record

Written to `gates.jsonl` by `verify.sh`, with `gate: "test"`. It carries `session_id` and `agent_id`, and no slice.

- The slice is resolved at read time by joining `agent_id` to a launch record.
- A record whose `session_id` differs from that launch's is ignored. `verify.sh` logs both.
- A record without `session_id` still counts through the join.
- A record of the hand-back gate carries `"at":"handback"` and `handback_id`; a stop's record carries `after_handback` when the stop follows a hand-back. `run.mjs` pairs records with stops by these ([docs/gates.md, Hand-back gate](gates.md#hand-back-gate)).
- Since 2.0.0 a failed run's record also carries `failed_count`, `failed_tests`, `failed_crash` and `output`, and one written by a gate that took over a stale lock `lock_takeover`.

### Ordering

A foreground worker's SubagentStop, and the test-gate record written at that stop, are logged before its PostToolUse launch record (journal.mjs:10).

- So a stop or gate record whose `agent_id` matches a launch record is placed at its effective time, `max(own ts, launch ts)`: never before its launch.
- Every launch, stop and gate record is ordered by that time.
- At equal times the launch comes first. The stops and gates keep the order of their own `ts` (a stop before a gate at equal `ts`).
- The effective time is also the time the record counts at: review times, run activity, staleness.
- A record whose launch never appears keeps its own `ts` and the handling it had before.

### Gate reasons of the run model

These reasons come from the run model:

| Reason | Gate | Give-up form |
|---|---|---|
| `agents_running` | review gate | none: it is an allow, never counted as a block, so it never gives up |
| `not_in_plan`, `builtin_agent_in_run` | plan check | `<reason>_gave_up` |
| `replan_required` | both gates | `<reason>_gave_up` |
| `constraints_unchecked`, `opus_review_required`, `implementer_unfinished`, `second_review_required` (2.1.0) | review gate | `<reason>_gave_up` |
| `run_state_unreadable` | review gate | `max_blocks_reached`, like the review gate's older reasons |

Each gives up (logs its give-up form and lets the launch or reply through) after 2 blocks: the [loop guard](glossary.md#l). `run_state_unreadable` blocks when the run state cannot be folded from the logs.

<a id="gates-slice-a1"></a>

## Gates

Hooks read the records through `.claude/hooks/run.mjs` (`loadRecords`, `sessionRuns`, `sliceOfAgent`; side-effect free at import). [docs/gates.md](gates.md) describes every gate for a reader; this part states how the gates use the run model.

### Unfinished implementers

A worker that stops at its turn limit, or is killed, fires no SubagentStop. So it has no stop record, no test-gate record and no attempt in the fold.

- Once nothing is running, the review gate blocks with `implementer_unfinished` for each implementer of the session that has both:
  - a latest SubagentStart (telemetry.jsonl) with no later SubagentStop, and
  - a launch record without the workflow marker (workflow agents are left to their script).
- An implementer whose latest test-gate record is a block with no later SubagentStop counts the same way. The message names that block's reason (the `tests_failed` text is unchanged).
- It is resolved when the implementer is resumed and stops, or when a later implementer stop record names the same slice. For a brief with no slice: any later implementer stop of the session. Since 1.6.1, after a test-gate block for `bugfix_base_unusable`, `bugfix_no_base`, `bugfix_timeout` or `bugfix_tmp_lost`, a later passing opus review of the slice also resolves it (logged in `skips` as `implementer_unfinished:<slice>:<reason>_cleared_by_review`); after `tests_failed`, `bugfix_no_test` or `bugfix_test_passes_on_base` it does not.
- Its loop guard is per implementer and lasts the session. Every block and give-up record lists the `agent_id`s of the unfinished implementers it named (`unfinished`). An implementer named in 2 blocks no longer carries a block. The next allow is logged as `implementer_unfinished_gave_up` (or `max_blocks_reached` when an older reason gave up with it) and names it. An implementer a give-up has named is ignored from then on. So an implementer the person stopped early in a long session costs two blocks once, not two after every later implementer stop.
- With no implementer stop in the session, an unfinished implementer is what keeps the gate from allowing with `no_implementer_in_session`.

A test-gate block counts the same way. The test gate (`verify.sh`) runs beside the journal at an implementer's stop and decides minutes later, so its block can land after a reviewer already passed the slice. An implementer whose latest test-gate record (`gates.jsonl`, gate `test`, joined by `agent_id`) is a block with no later SubagentStop of that implementer is gated as unfinished. It has the same reason, resolution, message intent (resume it with SendMessage) and per-implementer loop guard. Its next stop, or a later implementer stop of the same slice, resolves it.

### Review gate

`review-gate.mjs`, on Stop. Its reasons, their order and its loop guard are in [docs/gates.md, Review gate](gates.md#review-gate). From the run model it gates each slice of the latest run with an implementer attempt, and the slice of the session's last implementer. Its `constraints_unchecked` check reads the CHECKS of the passing reviewer's brief; a brief with no CHECKS skips it, logged in `skips`. An implementer with no slice in the run model (workflow agents, old briefs) falls back to the old rule, from telemetry.

### Plan check

`plan-check.mjs`, PreToolUse on Agent. It is scoped to the open run. With none open, it is scoped to the launches since the last run; a light launch opening the next run sees both. Each entry logs its `run`. Its reasons and loop guards are in [docs/gates.md, Plan check](gates.md#plan-check). `not_in_plan` compares FILES after `normalizeFiles`. Built-in names come from `BUILTIN_AGENTS` in `.claude/hooks/builtin-agents.mjs` plus those learned per machine in `~/.claude/orchestration/builtin-agents.json`.

<a id="stall-gate-and-gap-cutoff-in-the-gates-040"></a>

## Stall gate and gap cutoff in the gates

- **Review counting.** Both gates read reviews through the fold. So a low-confidence fail counts as a pass there: the Stop gate logs `last_reviewer_failed:<slice>:low_confidence` in `skips` and, with `low_confidence_fail` as a doubt signal, asks for an opus review. A VALIDATE review replaces the earlier reviews of its attempt. The Stop gate's fallback for an implementer outside the run model (the old rule, from telemetry) reads the raw STATUS and is unchanged.
- **Stop gate.** For a stalled slice whose latest review after its latest attempt is a counted fail, the Stop gate blocks with `replan_required` instead of `last_reviewer_failed`. The fix: send the plan reviewer a PLAN REVIEW brief with `REPLAN: <n>` and a changed approach, or report the slice as failed. The loop guard is as for the other newer reasons: 2 blocks since the last implementer stop, then allow with a systemMessage and `replan_required_gave_up` (`NEW_REASONS`).
- **Plan check.** While the open run's slice is stalled, an implementer launch with that SLICE blocks with `replan_required` (checked after `no_plan_review`). It blocks 2 times per slice, counted since the slice stalled (`stalledAt`); then the launch goes through as `replan_required_gave_up`. Other slices are not affected.
- **Switches.** `ORCH_GAP_MIN` and `ORCH_STALL_GATE` ([docs/settings.md](settings.md#plugin-settings)). With `ORCH_GAP_MIN=0` and `ORCH_STALL_GATE=off`, both gates count every failing review as a fail and never block with `replan_required`.
- **Native only.** The stall gate lives in `plan-check.mjs` and the Stop gate's per-slice check. The gated workflow's agents make no Agent tool call, and its implementer briefs carry `ORCHESTRATION: workflow`. So they never reach the plan check or the run model, and the gated workflow applies its own `gapMin` cutoff in code.

## API (`.claude/hooks/brief.mjs`)

| Export | Returns |
|---|---|
| `parseHeader(text)` | header fields of an implementer or reviewer brief |
| `parsePlan(text)` | the PLAN REVIEW plan |
| `parseReply(text)` / `parseStatus(text)` | status, open items, constraint answers / status only |
| `isPlanReview(text)` / `sliceOfBrief(text)` | the PLAN REVIEW marker / journal slice key (`plan`, the SLICE id, or `null`) |
| `isSkillName(name)` | the SKILL name rule (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters) |
| `normalizeFiles(files, baseDir)` | absolute paths: relative against `baseDir`, trailing slashes stripped, duplicates dropped |
| `isOpusModel(model)`, `modelFromAgentFile(text)`, `agentModel(toolInput, dirs)` | reviewer model rules |
| `briefUrls(text)` | unique http(s) URLs of a text, in order, at most 50 |
| `gapKey(text)` | the 8-hex-character key of a gap text (stop record `gaps`) |
| `launchRecord(toolInput, ctx)`, `stopRecord(ctx)` | the log records above |
| `foldRuns({ launches, stops, gates, starts, handbacks }, { now, staleMin, sessionId, gapMin, env })` | `{ runs, open }`: runs with slice states (`launches`, `attempts`, `reviews`, `final`, `passed`, `gaveUp`, `isolatedTestFailure`, planned `files`, `countedFails`, `stalled`, `stalledAt`, `stallKeys`, `signals`; since 2.1.0 `secondField`, `reviewsNeeded`, `handbackAt`, `secondReview`, and on reviews `agent`, `began`, `early`; reviews carry their brief's `checks`, `counted`, `lowConfidence`, `superseded`, `validate` and `keys`), plus `planReviewed`, `running` and `replans` per run. `gapMin` defaults to `gapMinimum(env)`; `env` defaults to `{}` |
| `currentReviews(slice)`, `countedStatus(review)` | reviews after the slice's latest implementer launch or stop; a review's counted status |
| `doubtSignals(slice, env)`, `hasOpusPass(slice)` | the opus review rule |
| `countingReviews(slice)`, `secondReviewVerdict(slice)`, `secondReviewOn(env)` | the second review rule (2.1.0): the reviews that count, the verdict, whether the switch leaves the rule on |
| `staleMinutes(env)`, `escalationMode(env)`, `gapMinimum(env)`, `stallGateOn(env)`, `MAX_RETRIES`, `RUN_STALE_MIN_DEFAULT`, `GAP_MIN_DEFAULT` | settings |

**Parity.** `parseHeader` reads `SLICE`, `FILES` and `DEPENDS` as `plan-check.mjs` logs them, and `sliceOfBrief` keys a brief as `journal.mjs` does. `src/brief.test.mjs` runs both hooks to check. One difference: `journal.mjs` finds no slice in ``SLICE: `s1` `` (an id in backticks); `parseHeader` reads `s1`, as `plan-check.mjs` does.
