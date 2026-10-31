# Live dashboard

The live dashboard is a pane beside the chat that draws an orchestration run while it happens. It is a Claude Code function-hooks mod; its source is `dashboard/register.tsx`. This page states what that code does.

## Opening it

- The pane opens when you submit a prompt (`prompt.submit`), in any folder: no git repository, checkout or code project is needed. Slash commands, meta prompts, blank prompts and prompts the engine queues that you did not type (a background task's notification, a peer session's message, a scheduled trigger; the `NOT_THE_PERSON` origins) do not open it and are not new work.
- It also opens when the first orchestration agent (researcher, implementer, reviewer or integrator) starts, and when a route verdict is recorded (the `route` tool, or the result of an `npm run route` Bash call in the main session).
- `/orchestration` opens it focused, so the arrow keys work at once.
- A pane nobody asked for seats only from 144 columns. On a narrower terminal a toast (shown once per run) says to type `/orchestration`.
## Run boundary

The pane uses the gates' run model ([brief-grammar.md, Run model](brief-grammar.md#run-model)), worked out from the agents it has seen (`runOpen`, `sliceRunOf`). It replaced the old rule that started a new run when the last agent had ended 2 minutes earlier.

- **A run opens** at a `PLAN REVIEW` launch without `REPLAN:` (closing the previous one), or at a light-path implementer launch (`PATH: light`) when none is open. A `PLAN REVIEW` with `REPLAN:` extends the open run: a slice it names again is updated, a new one is added. The scripted workflow's briefs (`ORCHESTRATION: workflow`) open nothing.
- **A run is open** while it is not stale and an agent runs or one of its slices is not final. A slice is final when it failed for good (its latest review, after its latest implementer launch or stop, failed after 3 implementer attempts, `MAX_RETRIES` 2), or when its latest review passed and its escalation rule is met: the pane shows no doubt signal for it, or an opus review passed after its latest implementer launch or stop ([brief grammar, Final slice](brief-grammar.md#run-model)). A slice that passed but still needs its opus review is not final, so the run stays open. The pane cannot read `ORCH_ESCALATION` (it uses the default) or see an isolated test failure, so it can call a slice final that the gate still holds for an opus review; attempts are counted from implementer stops, and stops with no review between them count as one. A run with no slice yet (a plan review alone, or a plan without `SLICE:` lines) stays open until a slice is known or it goes stale.
- **Stale**: agents ran, none runs and the last one ended more than 10 minutes ago (`STALE_MS`). The gates use `ORCH_RUN_STALE_MIN` (default 30) instead, so the pane can drop a run the gates still hold open.
- What starts a new run (the old agents, log, verdict, input, plan and run are dropped; what the session used is kept; `newRun`):
  - A prompt you type while no agent runs, the main session is not still working on an earlier prompt, and no run is open. A prompt never closes an open run: a headless run delivers background results as a new prompt, which only reopens the main turn.
  - A spawn, when the pane already holds agents and either a new plan arrives (a `PLAN REVIEW` without `REPLAN:` that names slices, while the pane holds slice agents) or the session is idle (the main turn is not working and nothing runs) and the run is closed or stale. Agents with no run (no plan review and no light path) are dropped only when stale. A `PLAN REVIEW` that names no slices, or the fixed plan after a failed plan review with no slice launched yet, keeps the agents so the re-plan loop shows.
  - On a spawn reset, the input line stays while the main turn still works on it or when it is newer than the old run's last agent, and the verdict stays when it is that new or came with the kept input. An older verdict or input is dropped.
  - Not counted as work: notifications and peer messages (see the `NOT_THE_PERSON` origins above) neither start a run nor open the pane.
  - A prompt while the main session still works on an earlier prompt with no answer yet drops nothing and keeps the first input; so does any prompt while an agent runs or a run is open.
  - A main turn that never reports its end (killed or interrupted) counts as ended once agents ran, none runs and the last one ended more than 10 minutes ago (`STALE_MS`): the run is stale too, and the next typed prompt or spawn starts a clean run. A main turn that is legitimately busy for over 10 minutes after the last agent ended is treated the same way.

## Scrolling and resizing

- When the content is taller than the pane, a hint line at the top says the arrow keys scroll. They work once the pane has the keyboard: click it or type `/orchestration`. Esc returns to the prompt.
- The layout follows the pane width. The stage boxes sit 6 to a row from 100 columns, 3 from 40, 2 below that, with a return rail between rows. The slice columns stack top to bottom when they would be narrower than 14 cells each; otherwise they sit side by side.

## Sections, top to bottom

1. **Model legend.** One coloured square per model in use.
2. **Progress.** Drawn once the run has a slice: a heading `progress · <done>/<total> slices · <percent>%` (with `· N running` and `· N failed` when there are any, and `· ↻ replan N` once a `PLAN REVIEW` with `REPLAN: N` arrived), a bar and one line per slice.
   - The slices are the plan's, in plan order: every `SLICE:` line of the latest `PLAN REVIEW` brief that names one (`planOf`, a mirror of `brief.mjs`'s `parsePlan`), except the review's own `SLICE: plan`. A slice's goal is the rest of its `SLICE:` line, else the first `GOAL:` line under it; its `RISKY:` and `CHECKS:` lines are kept with it. A slice named twice keeps its first entry. Markdown bullets, bold, a heading `#` and backticks around the id are accepted, and a trailing `:` on the id is dropped. A plan review without `REPLAN:` that names slices replaces the plan; one with `REPLAN:` extends the open run's plan (a slice named again is updated, a new one is added); one that names none keeps it. A new run drops it.
   - Then any slice that started outside the plan (a slice with no plan review, the light path, or one added later), in the order the diagram knows it, including a queued dependency while the run is going.
   - Each slice is counted at its latest attempt, with the card states: done once its review passed, or once it was built with no reviewer (`◆`), or when a later slice made its failure good. Queued until an agent of it starts.
   - The bar is 40 cells, or the pane width less 2 (at least 10), shared evenly by the slices in plan order: done green, running amber (pulsing), failed red, still to do grey. It is drawn in `━`, so it is never taken for flow-line art.
   - Up to 8 slice lines (`<glyph> <id> <marks> · <goal>`, cut to the width), then `+N more`. Marks follow the id only when they apply, so an old-style plan and reply show none (`marksOf`):
     - `⚑`: the slice is RISKY (its planned slice or an implementer brief says `RISKY: yes`).
     - `↻replan`: the slice is stalled and needs a `PLAN REVIEW` with `REPLAN:` before another attempt. The pane mirrors the gates' stall rule (`sliceRunOf`): the slice is not final, its latest counted review and the latest counted review of an earlier implementer attempt both failed, every counted review between them failed, the two share a gap key, and no REPLAN plan review ended after the later one. The plan check and the Stop gate block such a slice with `replan_required`.
     - `doubt`: a review of the latest attempt said `STATUS: fail` but counts as a pass, because every one of its `GAP:` lines is below the cutoff and no checked id failed (`countedOf`). The pane cannot read `ORCH_GAP_MIN`, so it uses the default cutoff, 80; a `GAP:` line with no number counts as 100. Such a review shows as passed on its card and in the tasks table.
     - `⇧opus?` when a doubt signal asks for an opus review and none has passed after the latest attempt; `⇧opus✔` once one has. The pane's signals are RISKY, an earlier failed review, a `(read)` answer or OPEN items in the passing review, and a low-confidence fail (the `doubt` mark); the gate also counts an isolated test failure, which the pane cannot see.
     - One tick per checked constraint id (the slice's planned and brief `CHECKS:`, plus any id its latest review answered), from that review: `C1✔` passed by a command, `C1✓` passed by reading, `C1✖` failed, `C1·` not answered.
   - The orchestrator is told to write each planned slice in the PLAN REVIEW brief as the `SLICE:`, `FILES:`, `DEPENDS:` and `GOAL:` lines its brief will start with (`.claude/agents/orchestrator.md` step 2a, the route skill and the SessionStart nudge). Without them the bar still follows the slices as they start, but the total grows as they do.

   ```text
   progress · 1/3 slices · 33% · 1 running · 1 failed · ↻ replan 1
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ✔ s1 C1✔ C2✓ · shared types
   ⠋ s2 ⚑ ⇧opus? · the handler
   ✖ s3 C2✖ · docs
   ```

   With 0.4.0 replies, a slice whose review failed only on low-confidence gaps and one that stalled read like this:

   ```text
   ✔ s4 doubt ⇧opus? C1✓ · parser
   ✖ s5 ↻replan · exporter
   ```
3. **Input box.** The first non-blank line of the prompt (cut to 120 characters), shown from the submit, with or without agents.
4. **Orchestrator box.** The orchestrator's model, a state line ("waiting for N agents" when the main turn has ended while background agents still run; dispatching with the count of running agents, also "0 running" between two waves while the main turn works; signed off with N failed, passed with N fixed on the way, or all agents passed), and the agent count, total tokens and elapsed time. With no agents the state line reads "working in this session" while the main turn runs, then "answered in this session", or "stopped before an answer" when the main turn ended with a reason other than an answer.
5. **Triage box.** Shows the mode (plain, reviewed or orchestrate). Three sources:
   - A recorded route verdict, from the `route` tool or from a captured `npm run route`: the mode, the facts (files, lines, slices, risky, code) and the reason. The Bash capture takes any main-session Bash call that matches `npm run route` (also `npm run --silent route`); the orchestrator agent cannot use it because its tool list has no Bash (`.claude/agents/orchestrator.md`), not because of the code.
   - Otherwise, with agents, the mode is inferred from the agents (an implementer, integrator or plan review means orchestrate; a reviewer alone means reviewed; any other agent means orchestrate) and the box says "(inferred from the agents)". Nothing in the code forces it, but under the orchestrator the triage is inferred: its tool list has neither Bash nor the `route` tool, so no verdict is recorded there.
   - With no agents and no verdict, the box reads "sizing…" while the main turn runs, then the mode "plain" with "(inferred: no agents ran)".

   A recorded verdict draws the box in the mode's colour; an inferred mode draws the same box with a dim border. Below it, a fork of three route boxes (plain, reviewed, orchestrate) shows which route was taken:
   - From 44 columns the three boxes sit side by side, with a line from the triage box to the chosen one. Below 44 columns the routes are stacked: with a mode, the two routes not taken are listed first as one-line `○ name` rows, then the chosen route as a box; with no mode yet, all three are listed as `○ name` rows.
   - The chosen route is active: a bold border (double once the run is signed off), a `◉` marker, its name in the mode's colour, and a status word in the status colour: `running`, `passed`, `failed`, `stopped` (a main turn that ended without an answer) or `chosen` (a mode with no work yet). The routes not taken are dim, with a round border and `○ not taken`.
   - While the mode is still being sized, all three boxes are dim (`○ …`) and the line from the triage box branches to all three; no route is linked to a stage.
   - The recorded verdict and the inferred mode draw the fork and the link the same way; only the triage box differs.

   ```text
   ╭────────────────────────────────────────────╮
   │triage · plain                              │
   │(inferred: no agents ran)                   │
   ╰────────────────────────────────────────────╯
    │
    └─────┐
          ▼
   ╔════════════╗  ╭────────────╮  ╭────────────╮
   ║plain       ║  │reviewed    │  │orchestrate │
   ║◉ ✔ passed  ║  │○ not taken │  │○ not taken │
   ╚════════════╝  ╰────────────╯  ╰────────────╯
          │
          └──────────────────────────────────────────────────┐
                                                             ▼
   ```
6. **Pipeline stages.** A box is drawn only once its stage is used; up to six: triage, plan, plan review, build, review, merge. Triage is always drawn. The stage the route enters shows dim ("next") once a mode is known. Every other stage appears once an agent of it started, or once the main session does its work: build reads "this session" while the main session builds in plain or reviewed, and plan turns done (marked "orchestrator") once a plan review or a build has started, because the orchestrator plans itself. A stage the run does not use is not drawn at all (nothing reads "skipped"); a stage that is not in the mode's usual path but has agents is still drawn. Each box has a glyph, one coloured cell per task (the most recent that fit, then `+N`; dim dots when empty), and a line with done/total and the model families (the triage box shows the mode). A link from the active route box enters the first stage the route uses: plan for orchestrate, build for plain and reviewed. The stage row holds up to 6 boxes from 100 columns, 3 from 40, 2 below that, counted over the drawn boxes, so the layout shifts as boxes appear. When the entry stage lands in the second row, the link runs down a lane at the right edge of the first row and turns into the box. Under 16 columns the link goes to the triage box (stage 0) instead. Arrows join the drawn boxes, and between rows a return rail runs from the last box back to the first of the next row. Loop-back connectors under the stage row show retries (see "Loop-back connectors" below).

   **Arrows follow active work.** The active stages are those with a running agent, and build while the main session works in plain or reviewed (a running retry or re-plan also makes its target stage active). With the main turn working and nothing running, the furthest stage used so far is active.
   - The route link and the stage arrows and rails, from the entry stage up to the furthest active stage, are amber with a dot moving along them. Arrows past it are grey.
   - With nothing live (idle or signed off) there is no dot: each arrow takes its stage's final colour, green for passed or done, red for failed, grey otherwise.
   - A running retry or re-plan lights its loop-back amber and bold; on one stage row the dot runs backward along it. A loop across rows gets no dot, only the bold amber. A loop is drawn only when both of its ends are drawn.
7. **Slice diagram.** One card per slice, in columns by dependency layer (a slice sits right of everything it waits for).
   - A rail on the left forks an arrowhead into every card of the first layer. The rail, forks and down connectors are coloured per card (amber running, red failed, green passed, grey queued); the dot runs only down to the lowest running card.
   - Routed box-drawing lines join each layer to the next, entering the target's middle with an arrowhead.
   - A dot travels along the edges whose target is running.
   - A retry is its own card (see "Attempts" below).
   - A bus under the diagram joins the final slices (those nothing depends on) into one arrow to the sign-off box. Each stub has its card's colour; the bus and its arrow take the best of them, in the order running > failed > passed > queued.
   - A card shows the state glyph, slice id and time; build and review chips; the running agent's latest tool, else the token count or "queued"; and a `◀` line per dependency (up to 3, then "+N more"), green once satisfied. A dependency not yet launched appears as a queued card while the run is going; once nothing runs and the main turn has ended those cards are left out (`nodesOf` with `ghosts` false), and the `◀` line stays, grey.

   **Attempts.** A card is one attempt of a slice (`nodesOf`). A new attempt starts when a non-reviewer agent of the slice starts at or after the end of a failed agent of that slice; reviewers stay in the attempt they review. The first attempt keeps the slice id; later ones are `X ↻2`, `X ↻3`.
   - Each retry sits in the layer right of the attempt before it and is joined to it by a retry connector, with a `↻` next to the arrowhead. The connector is amber while the retry runs, green once it passed and red while it failed or is unresolved (`retryTone`).
   - A slice that depends on a retried slice waits for its latest attempt and connects from it; its `◀` line names the slice.
   - A card of a retried slice carries a line `attempt k/n`, and a `◀ retry of X` line first among the `◀` lines (same colour as the retry connector). The `◀` lines show up to 3, then "+N more".
   - A first attempt that starts at or after the first failure end in the run (any agent) carries `✚ new` on that line: a slice added by a re-plan.
   - A resumed agent is a new attempt too. An `agent.spawn` for an id that already has a record adds a new record, and a turn that completes for a record that already ended adds a new record (its start is the old end, or the latest end of another agent of the slice if later); the old record stays as history. Tool updates and completions go to the latest still-running record of an id, else the latest. Because the new record starts after the failed one ended, it becomes a retry attempt.
8. **Sign-off box.** "waiting for N agents" while the main turn has ended and background agents still run, otherwise "waiting for agents · verified findings only" until the run is signed off (see "Sign-off" below), then the passed, failed and fixed counts. With no agents it reads "waiting for the reply", then "answered in this session" or "stopped". A failure counts as fixed (grey `◆`, "fixed by <card>" in the tasks table, e.g. "fixed by X ↻2") when a later attempt of the same slice passed, or else a later slice that depends on the failed slice started after it ended and passed, or, for an agent with no slice (a plan review), when a later slice-less agent with the same role and label passed. Fixed failures are not counted as failed in the stages or in the orchestrator box.
9. **Tasks table.** One row per attempt of a slice (the first keeps the slice id, a retry is `X ↻2`), or per agent without a slice: glyph, label, a share bar, tokens, time, and a second line with the reported result (the report's `Answer:` line, else its first non-heading line; a bare `GAPS:` heading (plain or in bold) is skipped so the finding under it shows) or, while running, the latest tool. A totals line gives input, output and cache tokens.
10. **Usage by model.** One stacked bar, one segment per model with tokens, and a legend with tokens and percentage per model.
11. **Session log.** The last 10 events (7 on a narrow pane): time since the run began, a mark, what happened, duration and tokens. A start entry ends with the model the agent was spawned with (`spawned.model` from the `agent.spawn` event), the same model its card and the usage bar use; for a researcher this is where a model chosen at launch shows. Whether that value reflects a model the read router set through the plan check's `updatedInput` has not been checked live (the router's own check read the model from telemetry; see [native-mode.md, Read router](native-mode.md#read-router-040-opt-in)). Triage verdicts are logged too. A started agent that opens a retry attempt is logged as `retry k of X · <label> started …`; a plan review that starts after a failed one ended is logged as `re-plan · …`. A resumed run that fires no spawn event logs its start entry when its turn completes. An `Agent` launch a gate denied (the plan check blocks before the agent exists, so no spawn follows) is logged as `⊘ blocked <reason>`, then ` · <slice>` and ` · <role>` when known; the reason is the gate's code when its message names one (`not_in_plan`, `builtin_agent_in_run`, `missing_lines`, `no_plan_review`, `light_path_multi`, `file_overlap`, `dependency_cycle` and the rest), else the code the plan check's message stands for. A `<reason>_gave_up` launch went through and is not logged as blocked.
12. **Used in this session.** What the whole session used, like the Claude desktop app's list, one row per kind with as many names as fit and then `+N`. It is kept across runs (a new run does not reset it) and drawn once anything was used, also before any agent.
    - `skills`: skills expanded for the model (`skill.prompt`: a `/name` command, the Skill tool, or a worker's preloaded skill), in first-use order.
    - `connectors`: MCP servers whose tools ran, named from the tool name (`mcp__claude_ai_Google_Drive__search_files` is "Google Drive"; the `claude_ai_` and `plugin_` prefixes go, underscores become spaces). The pane's own `route` tool counts.
    - `agents`: agents started, by bare type and count, any type (not only the four roles).
    - `tools`: built-in tools by count, most used first. The Agent and Skill tools are left out (they are the agents and skills rows), and so are MCP tools (connectors).
    - `edited`: base names of files Edit, Write or NotebookEdit changed, the latest first. `read`: how many other files Read read; a file read and then changed counts only as edited.
    - A call counts once it ran: a denied call or one that returned an error is left out. Calls of the main session and of every agent count.

## Loop-back connectors

Under the stage row (`loops` in `register.tsx`) a connector is drawn for each of these, only while its condition holds:

| Label | From, to | Condition | Colour |
| --- | --- | --- | --- |
| `↻ re-plan` | plan review to plan | a plan review started after a failed plan review ended | the latest such review: amber running, green passed, red failed |
| `↻ retry N` | review to build | N slices have more than one attempt | amber if any latest attempt runs, green if all passed or done, otherwise red |
| `↻ rebuild` | merge to build | an integrator failed and an implementer started after it ended | the implementers started after it: amber if any runs, green if all passed, otherwise red |

- A connector is drawn only when both of its boxes are drawn. When both are in the same stage row, it takes 3 rows: a `▲` over the target, a `└──┘` line and the label. When they are in different rows (fewer boxes per row on a narrow pane), it is one line, "<label> (back to <stage>)", under the row of its source stage, bold amber while live but with no dot. Lines are cut to the row width.
- Their rows count toward whether the pane needs the scroll hint.

## Sign-off

- With a typed prompt (the run has a `work` line): signed off only when no agent runs and the main turn has ended (`signed`, `workOpen`). Between two waves of agents the orchestrator box reads "dispatching… 0 running", the sign-off box "waiting for agents · verified findings only", queued ghost cards stay. When the main turn has ended while background agents still run (the orchestrator ended its turn to wait), both boxes read "waiting for N agents".
- Sign-off is about the screen; the run itself stays open until every slice is final (see "Run boundary"), so a prompt typed after sign-off joins the open run instead of starting a new one.
- With no typed prompt (agents without one, or background agents that wake the main session): signed off as soon as no agent runs. A flicker to signed off between waves can remain; this is a known limit.
- If the main turn never reports its end and the last agent ended more than 10 minutes ago (`STALE_MS`), the work counts as ended: the pane redraws once more and shows signed off. A turn that is truly busy for over 10 minutes after the last agent ended is treated the same, and a spawn after that starts a clean run.

A run with no agents (research or simple work that stays in the main session) shows the input box, the orchestrator box, the triage box, the stage boxes drawn so far (triage, the dim entry stage and build as "this session") and the sign-off box; the tasks table, usage bar and slice diagram need agents. Arrows join the boxes in turn: input to orchestrator, orchestrator to triage, triage to the route boxes, the chosen route to its first stage, and the stages to the slice diagram or the sign-off box. While the main turn works, the link and the arrows up to the active stage (build in plain or reviewed, the entry stage plan in orchestrate) are amber with a moving dot.

## Glyphs and colours

| Glyph | Meaning | Colour |
| --- | --- | --- |
| `●` or a spinner | running | amber |
| `✔` | passed | green |
| `✖` | failed | red |
| `◆` | finished with no STATUS line | grey |
| `◌` | queued | grey |
| `━` | the progress bar, one share per slice | green done, amber running, red failed, grey to do |
| `◉` | the route triage chose | status colour |
| `○` | a route not taken (or still being sized) | dim |
| `↻` | a retry connector, a retry card's connector, a loop-back label | amber running, green passed, red failed |
| `✚ new` | a slice added by a re-plan (on the card's attempt line) | dim |
| `⚑` | a RISKY slice (progress line) | as the line |
| `⇧opus?`, `⇧opus✔` | an opus review is needed and none passed yet, or one passed (progress line) | as the line |
| `C1✔`, `C1✓`, `C1✖`, `C1·` | a checked constraint passed by a command, passed by reading, failed, not answered (progress line) | as the line |
| `↻ replan N` | the plan was extended by a `PLAN REVIEW` with `REPLAN: N` (progress heading) | bold |
| `↻replan` | a stalled slice that needs a REPLAN plan review (progress line) | as the line |
| `doubt` | a review failed only on gaps below the cutoff and counts as a pass (progress line) | as the line |
| `⊘` | an Agent launch a gate blocked (session log) | red |

Flow lines are amber while work moves through them, green once what feeds them is done, grey before that. Models are coloured by family: opus magenta, sonnet yellow, haiku cyan, fable green, others white. Triage modes: plain grey, reviewed yellow, orchestrate cyan. A card is outlined with a double border for 2 seconds after an agent finishes.

## Where the data comes from

- Briefs and replies are read by a mirror of `.claude/hooks/brief.mjs` (the spec is [brief-grammar.md](brief-grammar.md)); the mod cannot import the hook, because the standalone `dist/dashboard` has no `hooks/brief.mjs`. `register.test.tsx` parses every fixture in `src/fixtures/briefs` with the mirror and checks `expected.json`, so parser, mirror and fixtures change together.
- The `SLICE:`, `FILES:` and `DEPENDS:` lines of each agent brief give a slice's id, its file count and its dependencies (the first matching line wins, as in the plan check); `RISKY:`, `CHECKS:` and `PATH: light` are kept for the marks and the run boundary. A brief that starts with `PLAN REVIEW` (only this one must be at the start) is labelled "plan review" and belongs to the plan review stage, whatever `SLICE:` line it also carries: it is never a slice card.
- The `Agent` spawn event gives the role, model and start time. The turn-complete event gives the report, the token usage and the end time; the report's status follows the one STATUS rule (any `STATUS: fail` line fails, otherwise the first STATUS line decides; blockquoted lines, a STATUS in mid-line and the template `STATUS: pass or fail` do not count; none means done), and its constraint answers, OPEN items and `GAP:` lines feed the marks (a reviewer's status is its counted status, as above). Tool calls give a running agent's latest tool; a denied `Agent` call gives a blocked log entry.
- The route verdict comes from the `route` tool, or from the result of a main-loop `npm run route` call.
- The plan comes from the `SLICE:` and `GOAL:` lines of the latest `PLAN REVIEW` brief that names a slice (see Progress above).
- "Used in this session" comes from `skill.prompt`, `agent.spawn` and every `tool.call` (after it ran, from its result).
- The input box and the no-agent states come from `prompt.submit` and the main thread's `turn.complete` (reason `answer` is answered; any other reason is stopped).

## The route tool

- A plugin-only install has no checkout, so no `npm run route`. The dashboard registers a model-callable tool, `route`, at session start so the model can record the verdict. The full name is `mcp__orchestration__route` in the plugin and `mcp__orchestration-dashboard__route` with the standalone mod (the build rewrites the name).
- It is not deferred: the model sees it without ToolSearch.
- Input: `mode` (plain, reviewed or orchestrate) and `reason` are required; `filesToTouch`, `linesToChange`, `independentSlices`, `risky` and `code` are optional.
- Calls from sub-agents, a non-object input, a bad mode and a non-text reason are ignored with a text result. A valid call records the verdict, logs it, opens the pane and returns "route recorded: <mode>".
- The Bash capture of `npm run route` still works for a checkout.

## Loading it

- The orchestration plugin ships it, built into `dist/plugin/hooks/dashboard.tsx`.
- In this repo the agents come from `.claude/`, not the plugin: `npm run orchestrate` runs `claude --agent orchestrator --plugin-dir dist/dashboard`.
- `npm run test-dashboard` runs the dashboard's own test (`claude plugin test`, skipped when the `claude` CLI is missing).
- `npm run build-plugin` rebuilds `dist/plugin` and `dist/dashboard` from `dashboard/`.

## Limits

- Claude Code reports no live token count for a running agent, so a task's tokens appear when the agent finishes.
- The orchestrator's own tokens are not counted.
- A dependency that skips a layer shows only as a `◀` line on its card, not as a drawn edge.
- Attempts are told apart by timing: a non-reviewer agent starting at or after a failed agent's end. A retry that starts while the failed agent is still running joins that card.
- Headless runs (`npm run native`, `npm run auto`, the benchmark) have no screen and draw nothing.
- The progress total is the plan's only when the PLAN REVIEW brief lists the slices as `SLICE:` lines; free-form plans fall back to the slices seen so far.
- The run boundary goes stale after 10 minutes with no agent running (`STALE_MS`), not after the gates' `ORCH_RUN_STALE_MIN` (default 30), so the pane can start a clean run while the gates still hold the old one.
- `⇧opus?` cannot see an isolated test failure (a test-gate record the pane does not read), so the gate may require an opus review the pane does not mark.
- The `doubt` and `↻replan` marks use the default gap cutoff 80; with `ORCH_GAP_MIN` set to another value the pane and the gates can disagree. A `VALIDATE: gaps` review that supersedes earlier reviews is not mirrored.
- The mod does not route workflow researchers: its `agent.spawn` handler only records the spawn. So workflow researchers are still not routed. A probe showed that under `claude -p` the hook runs, fires for workflow agents and can rewrite a workflow agent's model and prompt; mod code can use `$.fs.read`, `$.process.run` and imports inside the plugin, but not `node:` imports or files outside it. Routing workflow researchers this way is feasible and not implemented ([live checks: workflow agents](data/live-checks-workflow.md#answers)).
- "Used in this session" keeps the last 300 skills, connectors and files of each list, and shows file base names, so two files with the same name show twice.
- The stacked bar is at most 40 cells wide and at least 10, and each model with tokens needs one cell. It would overflow only with more such models than cells, which in practice means a very large number of distinct models.
