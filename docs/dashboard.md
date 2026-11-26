# The pane and status lines

The [pane](glossary.md#p) is a live view of a run, drawn beside the chat while the run happens. This page says how to open it, what each part shows and where its data comes from. It also covers the status line row under the prompt for each [worker](glossary.md#w).

The pane is a Claude Code function-hooks [mod](glossary.md#m). Its source is `dashboard/register.tsx`, and this page states what that code does. Users need "Opening it" and "Status lines"; the rest is for maintainers.

## Opening it

```text
/orchestration on     # turn the pane on and open it, focused
/orchestration off    # turn it off and close it
/orchestration        # switch between on and off
```

- The pane is off at every session start, in every terminal (herdr included). Only the command turns it on or off. The choice lasts for the session (the `enabled` state value).
- `/orchestration on` opens the pane focused, so the arrow keys work at once. Any other argument changes nothing and prints the usage. Each response is one line: the new state and how to switch back.
- While it is on, the pane opens by itself when you submit a prompt (`prompt.submit`), in any folder. No git repository, checkout or code project is needed.
- These prompts do not open it and are not new work: slash commands, meta prompts, blank prompts, and prompts the engine queues that you did not type. The last group is a background task's notification, a peer session's message and a scheduled trigger (the `NOT_THE_PERSON` origins).
- While it is on, it also opens when a worker (researcher, implementer, reviewer or integrator) starts. It opens when a route verdict is recorded too: by the `route` tool, or by the result of an `npm run route` Bash call in the main session. While it is off, none of these open it.
- The run is recorded while the pane is off (agents, log, plan, verdict, timer). Turning it on mid-run shows the run so far.
- A pane nobody asked for is placed only from 144 columns. On a narrower terminal, while the pane is on, a toast says to type `/orchestration on`. The toast shows once until the mod reloads.
- No hook of the pane blocks or fails the event it wraps. The pane's own work is wrapped, so a failed state write, `ui.open` or command registration still passes the prompt, spawn, tool call, turn or session start on.

## Run boundary

The pane uses the gates' [run](glossary.md#r) model ([brief-grammar.md, Run model](brief-grammar.md#run-model)). It works the model out from the agents it has seen (`runOpen`, `sliceRunOf`).

- **A run opens** at a `PLAN REVIEW` launch without `REPLAN:`, which closes the previous run. It also opens at a [light path](glossary.md#l) implementer launch (`PATH: light`) when no run is open.
- **A replan extends the open run** (a `PLAN REVIEW` with `REPLAN:`; "Progress" below). The [gated workflow](glossary.md#g)'s briefs (`ORCHESTRATION: workflow`) open nothing.
- **A run is open** while it is not closed (below) and not stale, and either an agent runs or one of its slices is not final.
- **A slice is final** as the gates define it ([brief-grammar.md, Final slice](brief-grammar.md#final-slice)). It failed for good, or its latest review passed and either the pane shows no [doubt signal](glossary.md#d) for it or an [opus review](glossary.md#o) passed after its latest implementer launch or stop. Where the pane sees fewer signals than the gate: [Limits](#limits).
- A slice that passed but still needs its opus review is not final, so the run stays open.
- Attempts are counted from implementer stops. Stops with no review between them count as one.
- A run with no slice yet (a plan review alone, or a plan without `SLICE:` lines) stays open until a slice is known or the run goes stale.
- **A run closes for good** (`closed` in the run state) when an agent with a slice finishes and every slice of the run is final, whatever else still runs. This is how the gates close it (`closeIfDone` in `brief.mjs`).
- **A closed run never reopens.** A late review that fails a final slice (a second opinion, or a reviewer launched late) leaves it closed. The next typed prompt, or a spawn once the session is idle, starts a clean run. A light-path launch opens a new light run. The gates do the same.
- **Carried slices** ([brief grammar, Run model](brief-grammar.md#run-model), "Carried slices"). A `PLAN REVIEW` without `REPLAN:` that closes an open run hands the new run two kinds of slice that it names again:
  - Each slice that is not final and whose latest review did not fail, with its agents (`carry`).
  - Each slice that was final and passed (`done`).
- A `done` slice counts as final in the new run until an implementer of it works there (a launch, or a resume's turn end) or a review of it fails there. A fail that counts as a pass does not end it. From then on the slice is judged from its agents in the new run, like any slice, so the run stays open.
- **What the run model reads.** The pane keeps its latest 80 agent records. It keeps older records only when the run model reads them: every agent with a slice, a `REPLAN` plan review and a running agent. The total is at most 500 records (`KEPT`, `KEPT_MAX`).
  - The cards, the tasks table and the counts draw the latest 80.
  - The run boundary and the marks read every kept record, so a retry signal or an earlier attempt does not fall off in a large run.
- **Stale**: agents ran, none runs, and the last one ended longer ago than the gates' stale time, `ORCH_RUN_STALE_MIN` minutes (default 30), which the pane reads as the gates do ("Where the data comes from").

What starts a new run (`newRun`). The old agents, log, verdict, input, plan and run are dropped; what the session used is kept.

- A prompt you type while no agent runs, the main session is not still working on an earlier prompt, and no run is open. A prompt never closes an open run: a [headless run](glossary.md#h) delivers background results as a new prompt, which only reopens the main turn.
- A spawn, when the pane already holds agents and one of these holds:
  - A new plan arrives: a `PLAN REVIEW` without `REPLAN:` that names slices, while the pane holds slice agents.
  - The session is idle (the main turn is not working and nothing runs), and the run is closed or stale.
- Agents with no run (no plan review and no light path) are dropped only when stale.
- A `PLAN REVIEW` that names no slices keeps the agents, so the replan loop shows. So does the fixed plan after a failed plan review, while no slice has launched yet.
- On a spawn reset, the input line stays while the main turn still works on it, or when it is newer than the old run's last agent. The verdict stays when it is that new or came with the kept input. An older verdict or input is dropped.
- A prompt while the main session still works on an earlier prompt, before its final report, drops nothing and keeps the first input. So does any prompt while an agent runs or a run is open.
- A main turn that never reports its end (killed or interrupted) counts as ended once agents ran, none runs and the last one ended longer ago than the stale time (above). The run is stale too, and the next typed prompt or spawn starts a clean run. A main turn that is truly busy for longer than that after the last agent ended is treated the same way.

## Scrolling and resizing

- When the content is taller than the pane, a hint line at the top says the arrow keys scroll. They work once the pane has the keyboard: click it, or type `/orchestration on` (which also focuses a pane that is already on). Esc returns to the prompt.
- The layout follows the pane width. The stage boxes sit 6 to a row from 100 columns, 3 from 40 and 2 below that, with a return rail between rows.
- The slice columns stack top to bottom when each would be narrower than 14 cells. Otherwise they sit side by side.

## Sections, top to bottom

1. **Model legend.** One coloured square per model in use.
2. **Progress.** Drawn once the run has a slice: a heading, a bar and one line per slice.
   - The heading reads `progress · <done>/<total> slices · <percent>%`. It adds `· N running` and `· N failed` when there are any, and `· ↻ replan N` once a `PLAN REVIEW` with `REPLAN: N` arrived.
   - The slices are the plan's, in plan order: every `SLICE:` line of the latest `PLAN REVIEW` brief that names one (`planOf`, a mirror of `brief.mjs`'s `parsePlan`). The review's own `SLICE: plan` is left out.
   - A slice's goal is the rest of its `SLICE:` line, else the first `GOAL:` line under it. Its `RISKY:` and `CHECKS:` lines are kept with it. A slice named twice keeps its first entry.
   - The id follows the slice id rule of a brief's header ([brief-grammar.md, Line rule](brief-grammar.md#line-rule)): `SLICE: "A1"` and `SLICE: A1.` are both `A1`. Markdown bullets, bold and a heading `#` before the key are accepted.
   - A plan review without `REPLAN:` that names slices replaces the plan. One with `REPLAN:` extends the open run's plan: a slice named again is updated, a new one is added. One that names none keeps the plan. A new run drops it.
   - After the plan's slices come slices that started outside the plan (no plan review, the light path, or added later), in the order the diagram knows them. This includes a queued dependency while the run is going.
   - Each slice is counted at its latest attempt, with the card states. It is done once its review passed, once it was built with no reviewer (`◆`), or when a later slice made its failure good. It is queued until an agent of it starts.
   - The bar is 40 cells, or the pane width less 2 (at least 10). The slices share it evenly in plan order: done green, running amber (pulsing), failed red, still to do grey. It is drawn in `━`, so it is never taken for flow-line art.
   - Up to 8 slice lines (`<glyph> <id> <marks> · <goal>`, cut to the width), then `+N more`. Marks follow the id only when they apply, so an old-style plan and reply show none (`marksOf`):
     - `⚑`: the slice is [risky](glossary.md#r) (its planned slice or an implementer brief says `RISKY: yes`).
     - `review N/2` (2.1.0): a RISKY slice under the [second review rule](glossary.md#s), with N the reviewer agents whose passes count for its latest attempt (0, 1 or 2). With fewer than two the slice stays running (amber); with two it is passed; a counted fail from either reviewer shows the slice as failed and drops the mark. The pane mirrors the fold (`needsTwo`, `secondStateOf` in `dashboard/register.tsx`): it decides from the slice's RISKY lines and `ORCH_SECOND_REVIEW` in its own environment, and marks an implementer launch as under the rule as the journal writes `reviews_needed`. The boundary a review must begin after is the implementer's `SubagentHandback` call as the pane sees it; when it missed that call it takes the implementer's stop, which is stricter, never laxer.
     - `↻replan`: a [stalled slice](glossary.md#s). It needs a `PLAN REVIEW` with `REPLAN:` before another attempt. The pane mirrors the gates' stalled-slice rule in `sliceRunOf` ([brief-grammar.md, Stall](brief-grammar.md#stall)). The plan check and the Stop gate block such a slice with `replan_required`.
     - `doubt`: a review of the latest attempt said `STATUS: fail` but counts as a pass, because every one of its `GAP:` lines is below the gates' cutoff (`ORCH_GAP_MIN`, default 80) and no checked id failed (`countedOf`). A `GAP:` line with no number counts as 100. Such a review shows as passed on its card and in the tasks table.
     - `⚠isolated`: the test gate logged an isolated test failure (`tests_failed_isolated`) for an implementer of the slice since the review before its latest attempt. `⚠gate gave up`: it logged a test gate that gave up (`max_blocks_reached`, `bugfix_unverified_gave_up`). Both come from `gates.jsonl` ("Where the data comes from").
     - `⇧opus?` when a doubt signal asks for an opus review and none has passed after the latest attempt; `⇧opus✔` once one has. The pane's signals are the gates' (`doubtSignals` in `brief.mjs`): RISKY, an earlier failed review, a `(read)` answer or OPEN items in the passing review, an isolated test failure, a test gate that gave up, and a low-confidence fail (the `doubt` mark). With `ORCH_ESCALATION=off` there are none; with `always` every slice has one.
     - One tick per checked constraint id, from the latest review. The ids are the slice's planned and brief `CHECKS:`, plus any id that review answered. `C1✔` passed by a command, `C1✓` passed by reading, `C1✖` failed, `C1·` not answered.
   - The orchestrator is told to write each planned slice in the PLAN REVIEW brief as the `SLICE:`, `FILES:`, `DEPENDS:` and `GOAL:` lines its brief will start with. The rule is in `.claude/agents/orchestrator.md` step 2a, the route skill and the SessionStart nudge. Without those lines the bar follows the slices as they start, and the total grows as they do.

   ```text
   progress · 1/3 slices · 33% · 1 running · 1 failed · ↻ replan 1
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ✔ s1 C1✔ C2✓ · shared types
   ⠋ s2 ⚑ review 1/2 ⇧opus? · the handler
   ✖ s3 C2✖ · docs
   ```

   A slice whose review failed only on low-confidence gaps, and a stalled slice, read like this:

   ```text
   ✔ s4 doubt ⇧opus? C1✓ · parser
   ✖ s5 ↻replan · exporter
   ```
3. **Input box.** The first non-blank line of the prompt, cut to 120 characters. It shows from the submit, with or without agents.
4. **Orchestrator box.** The orchestrator's model, a state line, the agent count, total tokens and elapsed time. The state line reads:
   - "waiting for N agents" when the main turn has ended while background agents still run;
   - "dispatching" with the count of running agents (also "0 running" between two waves while the main turn works);
   - "N slices not final: <ids>" (for one, "1 slice not final: s2") when nothing runs and the main turn has ended, but a slice of the open run is not final yet;
   - at sign-off: "signed off with N failed", "passed · N fixed on the way", or "all agents passed";
   - with no agents: "working in this session" while the main turn runs, then "answered in this session", or "stopped before an answer" when the main turn ended for a reason other than an answer.
5. **Triage box.** Shows the [route](glossary.md#r) (plain, reviewed or orchestrate), from one of three sources:
   - A recorded route verdict, from the `route` tool or from a captured `npm run route`: the mode, the facts (files, lines, slices, risky, code) and the reason. The Bash capture takes any main-session Bash call that matches `npm run route` (also `npm run --silent route`).
   - Otherwise, with agents, the mode is inferred from them: an implementer, integrator or plan review means orchestrate; a reviewer alone means reviewed; any other agent means orchestrate. The box says "(inferred from the agents)". Under the orchestrator the triage is always inferred: its tool list (`.claude/agents/orchestrator.md`) has neither Bash nor the `route` tool, so no verdict is recorded there.
   - With no agents and no verdict, the box reads "sizing…" while the main turn runs, then "plain" with "(inferred: no agents ran)".

   A recorded verdict draws the box in the mode's colour. An inferred mode draws the same box with a dim border. Below it, a fork of three route boxes (plain, reviewed, orchestrate) shows which route was taken:
   - From 44 columns the three boxes sit side by side, with a line from the triage box to the chosen one.
   - Below 44 columns the routes are stacked. With a mode, the two routes not taken come first as one-line `○ name` rows, then the chosen route as a box. With no mode yet, all three are `○ name` rows.
   - The chosen route is active: a bold border (double once the run is signed off), a `◉` marker, its name in the mode's colour, and a status word in the status colour. The status word is `running`, `passed`, `failed`, `stopped` (a main turn that ended without a final report) or `chosen` (a mode with no work yet).
   - The routes not taken are dim, with a round border and `○ not taken`.
   - While the mode is still being sized, all three boxes are dim (`○ …`), and the line from the triage box branches to all three. No route is linked to a stage.
   - A recorded verdict and an inferred mode draw the fork and the link the same way. Only the triage box differs.

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
6. **Stages.** Up to six boxes: triage, plan, plan review, build, review, merge. A box is drawn only once its stage is used.
   - Triage is always drawn. The stage the route enters shows dim ("next") once a mode is known.
   - Every other stage appears once an agent of it started, or once the main session does its work. Build reads "this session" while the main session builds on the plain or reviewed route. Plan turns done (marked "orchestrator") once a plan review or a build has started, because the orchestrator plans itself.
   - A stage the run does not use is not drawn at all (nothing reads "skipped"). A stage outside the mode's usual path that has agents is still drawn.
   - Each box has a glyph, one coloured cell per task (the most recent that fit, then `+N`; dim dots when empty), and a line with done/total and the model families. The triage box shows the mode instead.
   - A link from the active route box enters the first stage the route uses: plan for orchestrate, build for plain and reviewed.
   - The boxes per row ("Scrolling and resizing") are counted over the drawn boxes, so the layout shifts as boxes appear. When the entry stage lands in the second row, the link runs down a lane at the right edge of the first row and turns into the box. Under 16 columns the link goes to the triage box (stage 0) instead.
   - Arrows join the drawn boxes. Between rows a return rail runs from the last box back to the first box of the next row.
   - Loop-back connectors under the stage row show retries ("Loop-back connectors" below).

   **Arrows follow active work.** The active stages are those with a running agent. Build is active while the main session works on the plain or reviewed route. A running retry or replan also makes its target stage active. With the main turn working and nothing running, the furthest stage used so far is active.
   - The route link, and the stage arrows and rails from the entry stage up to the furthest active stage, are amber with a dot moving along them. Arrows past it are grey.
   - With nothing live (idle or signed off) there is no dot. Each arrow takes its stage's final colour: green for passed or done, red for failed, grey otherwise.
   - A running retry or replan lights its loop-back amber and bold. On one stage row the dot runs backward along it. A loop across rows gets no dot, only the bold amber. A loop is drawn only when both of its ends are drawn.
7. **Slice diagram.** One card per slice, in columns by dependency layer: a slice sits right of everything it waits for.
   - A rail on the left forks an arrowhead into every card of the first layer. The rail, forks and down connectors are coloured per card: amber running, red failed, green passed, grey queued. The dot runs only down to the lowest running card.
   - Box-drawing lines join each layer to the next and enter the target's middle with an arrowhead. A dot travels along the edges whose target is running.
   - A retry is its own card ("Attempts" below).
   - A bus under the diagram joins the final slices (those nothing depends on) into one arrow to the sign-off box. Each stub has its card's colour. The bus and its arrow take the best of them, in the order running > failed > passed > queued.
   - A card shows the state glyph, slice id and time, and build and review chips. Below them: the running agent's latest tool (else the token count or "queued"), and a `◀` line per dependency (up to 3, then "+N more"), green once satisfied.
   - A dependency not yet launched appears as a queued card while the run is going. Once nothing runs and the main turn has ended, those cards are left out (`nodesOf` with `ghosts` false), and the `◀` line stays, grey.

   **Attempts.** A card is one attempt of a slice (`nodesOf`).
   - A new attempt starts when a non-reviewer agent of the slice starts at or after the end of a failed agent of that slice. An implementer with another agent id than the attempt's implementer also starts a new attempt, even while that one still runs. Reviewers stay in the attempt they review.
   - The first attempt keeps the slice id; later ones are `X ↻2`, `X ↻3`.
   - Each retry sits in the layer right of the attempt before it, joined to it by a retry connector with a `↻` next to the arrowhead. The connector is amber while the retry runs, green once it passed, and red while it failed or is unresolved (`retryTone`).
   - A slice that depends on a retried slice waits for its latest attempt and connects from it. Its `◀` line names the slice.
   - A card of a retried slice carries a line `attempt k/n`, and a `◀ retry of X` line first among the `◀` lines, in the colour of the retry connector.
   - A first attempt that starts at or after the first failure end in the run (any agent) carries `✚ new` on that line: a slice added by a replan.
   - A resumed agent gets a new record; the old record stays as history. An `agent.spawn` for an id that already has a record adds one. A `SendMessage` from the main session to an agent that has ended adds a running record at once, starting at the resume: the agent is found by id, else by the name its Agent call gave (the latest started of that name), as Claude Code resolves it. Until that record stops, the run model ignores it when it decides which reviews count, since the gates see a resume only at its stop (`pendingResume`).
   - A turn that completes for a record that already ended, with no such resume seen, adds a new record too; its start is the old end, or the latest end of another agent of the slice if that is later. A reviewer is the exception: its turn ending again with no resume between (the stop after a [hand-back](glossary.md#h)) replaces its review, unless an implementer of the slice launched or stopped after it, so one review counts once.
   - Tool updates and completions go to the latest still-running record of an id, else the latest record. A new record that starts after a failed agent of its attempt ended becomes a retry attempt.
8. **Sign-off box.** It reads:
   - "waiting for N agents" while the main turn has ended and background agents still run;
   - "N slices not final: <ids>", as in the orchestrator box;
   - otherwise "waiting for agents · verified findings only" until the run is signed off ("Sign-off" below), then the passed, failed and fixed counts;
   - with no agents, "waiting for the reply", then "answered in this session" or "stopped".

   A failure counts as fixed (grey `◆`, and "fixed by <card>" in the tasks table, for example "fixed by X ↻2") in three cases:
   - a later attempt of the same slice passed;
   - a later slice that depends on the failed slice started after it ended and passed;
   - for an agent with no slice (a plan review), a later slice-less agent with the same role and label passed.

   Fixed failures are not counted as failed in the stages or in the orchestrator box. Nor are reviews that a [gap validation](glossary.md#g) set aside: they count as done. A reviewer reply with no STATUS line gave no verdict and counts as failed in every cell, the header and the review stage, as on its card.
9. **Tasks table.** One row per attempt of a slice (the first keeps the slice id, a retry is `X ↻2`), or per agent without a slice.
   - Each row has a glyph, label, share bar, tokens and time.
   - A second line holds the reported result: the [reply](glossary.md#r)'s `Answer:` line, else its first non-heading line. A bare `GAPS:` heading (plain or in bold) is skipped, so the finding under it shows. While the agent runs, the line holds its latest tool.
   - A totals line gives input, output and cache tokens.
10. **Usage by model.** One stacked bar with one segment per model with tokens, and a legend with tokens and percentage per model.
11. **Session log.** The last 10 events (7 on a narrow pane): time since the run began, a mark, what happened, duration and tokens.
    - A start entry ends with the model the agent was spawned with (`spawned.model` from the `agent.spawn` event), the same model its card and the usage bar use. For a researcher, this is where a model chosen at launch shows. Whether that value reflects a model the [read router](glossary.md#r) set through the plan check's `updatedInput` has not been checked live. The router's own check read the model from telemetry; see [gates.md, Read router](gates.md#read-router).
    - Triage verdicts are logged too.
    - A started agent that opens a retry attempt is logged as `retry k of X · <label> started …`. A plan review that starts after a failed one ended is logged as `re-plan · …`.
    - A `SendMessage` resume logs its start entry at once (`resumed · <label> started …`, or the retry note when it opens a retry attempt). A resumed run the pane sees by neither a spawn nor a `SendMessage` logs a start entry, when its turn completes, only when it opens a retry attempt (the retry note) or is a plan review after a failed one (`re-plan`; `startNote`); otherwise it logs only its end entry.
    - An `Agent` launch a gate denied is logged as `⊘ blocked <reason>`, then ` · <slice>` and ` · <role>` when known. The plan check blocks before the agent exists, so no spawn follows. The reason is the gate's code when its message names one (`not_in_plan`, `builtin_agent_in_run`, `missing_lines`, `no_plan_review`, `light_path_multi`, `file_overlap`, `dependency_cycle` and the rest; since 2.1.0 also `wave_full`, `replan_required`, `worktree_base_not_head` and `implementer_unfinished`), else the code the plan check's message stands for (`GATE_REASONS` and `GATE_PHRASES` in `dashboard/register.tsx`, a list of its own: the pane cannot import the hooks).
    - A `<reason>_gave_up` launch went through and is not logged as blocked.
12. **Used in this session.** What the whole session used, like the Claude desktop app's list. One row per kind, with as many names as fit, then `+N`. It is kept across runs (a new run does not reset it) and drawn once anything was used, also before any agent.
    - `skills`: skills expanded for the model (`skill.prompt`: a `/name` command, the Skill tool, or a worker's preloaded skill), in first-use order.
    - `connectors`: MCP servers whose tools ran, named from the tool name. `mcp__claude_ai_Google_Drive__search_files` is "Google Drive": the `claude_ai_` and `plugin_` prefixes go, and underscores become spaces. The pane's own `route` tool counts.
    - `agents`: agents started, by bare type and count, any type (not only the four workers).
    - `tools`: built-in tools by count, most used first. The Agent and Skill tools are left out (they are the agents and skills rows), and so are MCP tools (connectors).
    - `edited`: base names of files that Edit, Write or NotebookEdit changed, the latest first. `read`: how many other files Read read. A file read and then changed counts only as edited.
    - A call counts once it ran: a denied call, or one that returned an error, is left out. Calls of the main session and of every agent count.

## Loop-back connectors

Under the stage row (`loops` in `register.tsx`) a connector is drawn for each of these, only while its condition holds:

| Label | From, to | Condition | Colour |
| --- | --- | --- | --- |
| `↻ re-plan` | plan review to plan | a plan review started after a failed plan review ended | the latest such review: amber running, green passed, red failed |
| `↻ retry N` | review to build | N slices have more than one attempt | amber if any latest attempt runs, green if all passed or done, otherwise red |
| `↻ rebuild` | merge to build | an integrator failed and an implementer started after it ended | the implementers started after it: amber if any runs, green if all passed, otherwise red |

- A connector is drawn only when both of its boxes are drawn.
- When both boxes are in the same stage row, the connector takes 3 rows: a `▲` over the target, a `└──┘` line and the label.
- When they are in different rows (fewer boxes per row on a narrow pane), it is one line, "<label> (back to <stage>)", under the row of its source stage. It is bold amber while live, with no dot. Lines are cut to the row width.
- Their rows count toward whether the pane needs the scroll hint.

## Sign-off

- **With a typed prompt** (the run has a `work` line), the pane signs off only when no agent runs, the main turn has ended and every slice of the open run is final (`signed`, `workOpen`, `openSlicesOf`). Until then the orchestrator and sign-off boxes show the waiting states of sections 4 and 8, including "N slices not final: <ids>".
- A run that is closed or stale, or no run at all (no plan review, no light path), holds nothing back: the pane then signs off once nothing runs and the main turn has ended.
- **With no typed prompt** (agents without one, or background agents that wake the main session), the pane signs off as soon as no agent runs and no slice of an open run is still not final. With no run it can flicker to signed off between waves; see "Limits".
- A main turn that counts as ended after the stale time without a report of its end ("Run boundary") also signs off: the pane redraws once more and shows signed off.

**A run with no agents** (research or simple work that stays in the main session) shows the input, orchestrator, triage and sign-off boxes. It also shows the stage boxes drawn so far: triage, the dim entry stage, and build as "this session". The tasks table, usage bar and slice diagram need agents.

Arrows join the boxes in turn: input to orchestrator, orchestrator to triage, triage to the route boxes, the chosen route to its first stage, and the stages to the slice diagram or the sign-off box. While the main turn works, the active stage is build on the plain or reviewed route, and the entry stage plan on the orchestrate route ("Arrows follow active work" above).

## Glyphs and colours

| Glyph | Meaning | Colour |
| --- | --- | --- |
| `●` or a spinner | running | amber |
| `✔` | passed | green |
| `✖` | failed | red |
| `◆` | finished with no STATUS line (a reviewer with none reads as failed), or a failure fixed later | grey |
| `◌` | queued | grey |
| `━` | the progress bar, one share per slice | green done, amber running, red failed, grey to do |
| `◉` | the route triage chose | status colour |
| `○` | a route not taken (or still being sized) | dim |
| `↻` | a retry connector, a retry card's connector, a loop-back label | amber running, green passed, red failed |
| `✚ new` | a slice added by a replan (on the card's attempt line) | dim |
| `⚑` | a RISKY slice (progress line) | as the line |
| `review N/2` | a RISKY slice under the second review rule, N of its two passing reviews in (progress line) | as the line |
| `⇧opus?`, `⇧opus✔` | an opus review is needed and none passed yet, or one passed (progress line) | as the line |
| `C1✔`, `C1✓`, `C1✖`, `C1·` | a checked constraint passed by a command, passed by reading, failed, not answered (progress line) | as the line |
| `↻ replan N` | the plan was extended by a `PLAN REVIEW` with `REPLAN: N` (progress heading) | bold |
| `↻replan` | a stalled slice that needs a REPLAN plan review (progress line) | as the line |
| `doubt` | a review failed only on gaps below the cutoff and counts as a pass (progress line) | as the line |
| `⚠isolated`, `⚠gate gave up` | the test gate logged an isolated test failure, or gave up, for the slice (progress line) | as the line |
| `⚠` | older test-gate records were not read (a line under the slices) | dim |
| `⊘` | an Agent launch a gate blocked (session log) | red |

- Flow lines are amber while work moves through them, green once what feeds them is done, grey before that.
- Models are coloured by family: opus magenta, sonnet yellow, haiku cyan, fable green, others white.
- Routes: plain grey, reviewed yellow, orchestrate cyan.
- A card is outlined with a double border for 2 seconds after an agent finishes.

## Where the data comes from

- **Briefs and replies** are read by a mirror of `.claude/hooks/brief.mjs` (the spec is [brief-grammar.md](brief-grammar.md)). The mod cannot import the hook, because the standalone `dist/dashboard` has no `hooks/brief.mjs`. `register.test.tsx` parses every fixture in `src/fixtures/briefs` with the mirror and checks `expected.json`, so parser, mirror and fixtures change together.
- **Brief lines.** The `SLICE:`, `FILES:` and `DEPENDS:` lines of each agent brief give a slice's id, its file count and its dependencies. The first matching line wins, as in the plan check. `RISKY:`, `CHECKS:` and `PATH: light` are kept for the marks and the run boundary.
- **Plan reviews.** A brief that starts with `PLAN REVIEW` (only this line must be at the start) is labelled "plan review" and belongs to the plan review stage, whatever `SLICE:` line it also carries. It is never a slice card.
- **Agent events.** The `Agent` spawn event gives the role, model and start time. The turn-complete event gives the reply, the token usage and the end time.
- **Reply status** follows the one [STATUS rule](glossary.md#s); a reply with no STATUS line counts as done, except a reviewer's, which gave no verdict and is drawn as failed. A reviewer's status is its [counted status](glossary.md#c). The reply's constraint answers, OPEN items and `GAP:` lines feed the marks.
- **Test-gate records.** At each agent start and end and at each prompt the pane reads the last MiB of each `gates.jsonl` the hooks may write (the project's `.claude/state/`, and the per-user and plugin state dirs for this project), read only. It keeps the records of the implementers it knows whose reason is `tests_failed_isolated`, `max_blocks_reached` or `bugfix_unverified_gave_up`, for the `⚠` marks and the doubt signals. When a file is longer than that, it skips the first, possibly cut, line and shows `⚠ older test-gate records not read (gates.jsonl over 1 MiB)` under the slices.
- **The gates' settings.** At each session start the pane reads `ORCH_RUN_STALE_MIN`, `ORCH_GAP_MIN` and `ORCH_ESCALATION` as the hooks read them: the environment variable when it is set (even empty), else the plugin setting when it is not empty, else the default (30 minutes, 80, the escalation rule). Since 2.1.0 it also reads `ORCH_SECOND_REVIEW` from the environment only (there is no plugin setting): `off`, in any case, turns the second review rule off. The standalone `dist/dashboard` declares no plugin settings, so there only the environment and the defaults apply.
- **Tool calls** give a running agent's latest tool. A denied `Agent` call gives a blocked log entry. A main-session `SendMessage` to an agent that has ended opens its resumed record ("Attempts").
- **The route verdict** comes from the `route` tool, or from the result of a main-session `npm run route` call.
- **The plan** comes from the `SLICE:` and `GOAL:` lines of the latest `PLAN REVIEW` brief that names a slice ("Progress" above).
- **"Used in this session"** comes from `skill.prompt`, `agent.spawn` and every `tool.call` (after it ran, from its result).
- **The input box and the no-agent states** come from `prompt.submit` and the main thread's `turn.complete`. Reason `answer` means answered; any other reason means stopped.

## The route tool

- A plugin-only install has no checkout, so no `npm run route`. The pane's mod registers a tool the model can call, `route`, at session start, so the model can record the verdict.
- The full name is `mcp__orchestration__route` in the plugin and `mcp__orchestration-dashboard__route` with the standalone mod (the build rewrites the name). The `/route` skill calls it once after sizing, so the pane shows the triage.
- It is not deferred: the model sees it without ToolSearch.
- Input: `mode` (plain, reviewed or orchestrate) and `reason` are required. `filesToTouch`, `linesToChange`, `independentSlices`, `risky` and `code` are optional.
- Calls from subagents, a non-object input, a bad mode and a non-text reason are ignored, with a text result. A valid call records the verdict, logs it, opens the pane and returns "route recorded: <mode>".
- The Bash capture of `npm run route` still works in a checkout.

## Loading it

```sh
npm run orchestrate       # claude --agent orchestrator --plugin-dir dist/dashboard: this repo's agents plus the pane
npm run test-dashboard    # the pane's own test (claude plugin test); skipped when the claude CLI is missing
npm run build-plugin      # rebuild dist/plugin and dist/dashboard from dashboard/
```

- The orchestration plugin ships the pane, built into `dist/plugin/hooks/dashboard.tsx`.
- In this repo the agents come from `.claude/`, not the plugin, so `npm run orchestrate` loads the standalone mod from `dist/dashboard`.
- Loading it there makes Claude Code write `tsconfig.json` and `.claude-plugin/types/` into `dist/dashboard`; git ignores both and `npm run check-plugin` skips them, so they may stay.

## Status lines

The mod draws the row of each worker under the prompt. The repo no longer ships a main status line: the script that used to be here was a personal one and was removed after 2.1.2 ([CHANGELOG.md](../CHANGELOG.md), 2.2.0).

### The row of each worker

Claude Code shows a row under the prompt for each running subagent. Since 1.6.1 the mod rewrites the row of each of this plugin's workers through its `AgentRow` render hook (`ui.render` on `AgentRow` in `dashboard/register.tsx`), also while the pane is off. 1.2.0 to 1.6.0 did this with a `subagentStatusLine` script shipped as the plugin's `settings.json`; Claude Code 2.1.326 calls that setting deprecated in favour of mods, so the plugin no longer ships `settings.json`.

```text
implementer s2 #2 risky · opus · 41.2k (21%) · Running the tests
```

- **Form:** `<role> <slice> #<attempt> <flags> · <model family> · <tokens> (<share of the context window>) · <progress line>`.
- **Plan reviews** show `reviewer plan`, or `reviewer replan` for a replan, instead of a slice.
- **Flags:** `validate` for a [gap validation](glossary.md#g) review, `risky` for a RISKY launch. A task status Claude Code reports other than `running` is added before the progress line.
- **The attempt number** counts fresh implementer launches of the slice within the run. A `PLAN REVIEW` launch without `REPLAN:` starts a new count, so a slice id an earlier run of the session also used starts again at 1. A replan keeps counting. A `SendMessage` resume makes no launch, so it keeps its number. `#n` shows only from 2.
- **Where it comes from.** The slice, attempt and flags come from the mod's own agent records, kept whether the pane is on or off. A row whose launch is not recorded yet shows the role without them. A state read that fails keeps Claude Code's own row.
- **Width.** A row is cut by display width over graphemes, whole graphemes only, ending in "…". Wide East Asian characters and emoji count two columns.
- **Other agents** (built-ins, other plugins) keep the rows Claude Code draws.
- **Your own setting wins.** A `subagentStatusLine` in your own or the project's settings draws the row first, and the mod leaves a row that arrives already drawn. `.claude/hooks/subagent-statusline.mjs` is kept for that use: name it in your own `subagentStatusLine` to get the same rows from the launch records (`journal-launches.jsonl`).
- **Checked** on the mod's test host (`npm run test-dashboard`, which CI runs since 2.0.0). Rows in this format were captured once in a live interactive session ([probes b2](data/probes-2.0.0-b2.md), Probe 1), but which component drew them there was not established ([Limits](limits.md), A, K2).

## Limits

- Claude Code reports no live token count for a running agent, so a task's tokens appear when the agent finishes.
- The orchestrator's own tokens are not counted.
- A dependency that skips a layer shows only as a `◀` line on its card, not as a drawn edge.
- Attempts are told apart by timing ("Attempts" above). A fresh implementer always starts its own attempt, but a retry by another role that starts while the failed agent still runs joins that card.
- Headless runs (`npm run native`, `npm run auto`, the benchmark) have no screen and draw nothing.
- The progress total is the plan's only when the PLAN REVIEW brief lists the slices as `SLICE:` lines. Free-form plans fall back to the slices seen so far.
- The pane reads the gates' settings once per session start (a reload reads them again). The standalone `dist/dashboard` declares no plugin settings, so it reads only the environment and the defaults.
- With no typed prompt and no run (no plan review, no light path), the pane can flicker to signed off between two waves of agents.
- Since 2.0.0 the pane reads the last MiB of each `gates.jsonl` for an isolated test failure (`tests_failed_isolated`, mark `⚠isolated`) and a test gate that gave up (`max_blocks_reached`, `bugfix_unverified_gave_up`, mark `⚠gate gave up`). When a `gates.jsonl` is longer than that, a line under the slices says older test-gate records were not read, and the pane may then miss a doubt signal the gates see.
- A `SendMessage` resume is matched to its agent by id, else by the name the Agent call gave (the latest started of that name), as Claude Code resolves it.
- The second stop of a [hand-back](glossary.md#h) is mirrored for reviewers only. `brief.mjs` reads `continues` on the stop record (set from `stop_hook_active`) and counts the two stops as one, for any worker. `turn.complete` carries no `stop_hook_active`, so the pane goes by the shape instead: a reviewer's turn that ends again with no resume between replaces its review ("Attempts"). Since 2.0.1, as in the fold, the replaced review keeps its end time when an implementer of the slice launched or stopped after it, so it stays a review of the attempt it read; and a reviewer woken after its report reached the orchestrator that ends with no STATUS line keeps its review as it was, adding only the turn's tokens (the journal writes no stop record for such a stop). For another worker that turn end is recorded as a resumed record, which counts once more in the header's counts.
- The run model reads at most 500 agent records ("Run boundary"). A run with more can lose an early attempt or failed review.
- A `SendMessage` resume counts on the pane only from its stop, as in the gates (`pendingResume`). A resume that fires `agent.spawn` again counts from its launch; that this matches the gates is not established, so while it runs the pane and the gate may briefly disagree about which review counts.
- The mod does not route [workflow agents](glossary.md#w): its `agent.spawn` handler only records the spawn, so workflow researchers are still not routed. A probe showed that routing them there is feasible; it is not built ([native-mode.md, Checked live](native-mode.md#checked-live), Check G; [live checks: workflow agents](data/live-checks-workflow.md#answers)).
- "Used in this session" keeps the last 300 skills, connectors and files of each list, and shows file base names, so two files with the same name show twice.
- The stacked bar is at most 40 cells wide and at least 10, and each model with tokens needs one cell. It would overflow only with more such models than cells, which in practice means a very large number of distinct models.
- The second review rule (2.1.0) on the pane. A slice that becomes RISKY only through a replan after its implementer was launched uses the two-review rule on its slice line, but its diagram card keeps the one-review rule. The pane's hand-back time is the moment it sees the `SubagentHandback` tool call, which can differ slightly from the time of the hook's record in `handbacks.jsonl`. The pane does not read `handbacks.jsonl`, so it cannot tell when the hooks could not read it and fell back to one review.
- Status line widths follow Unicode's East_Asian_Width and emoji properties. A terminal that draws ambiguous-width characters as two columns shows those rows wider than counted.
