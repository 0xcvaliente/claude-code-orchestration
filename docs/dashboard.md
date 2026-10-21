# Live dashboard

The live dashboard is a pane beside the chat that draws an orchestration run while it happens. It is a Claude Code function-hooks mod; its source is `dashboard/register.tsx`. This page states what that code does.

## Opening it

- The pane opens when you submit a prompt (`prompt.submit`), in any folder: no git repository, checkout or code project is needed. Slash commands, meta prompts and blank prompts do not open it.
- It also opens when the first orchestration agent (researcher, implementer, reviewer or integrator) starts, and when a route verdict is recorded (the `route` tool, or the result of the `/route` skill's `npm run route` command).
- `/orchestration` opens it focused, so the arrow keys work at once.
- A pane nobody asked for seats only from 144 columns. On a narrower terminal a toast (shown once per run) says to type `/orchestration`.
- What starts a new run (the old agents, log, verdict and input are dropped; `newRun`):
  - Nothing is running and the last agent ended 2 minutes or more earlier (or no agent ever ran). A prompt or a first agent after that starts a new run.
  - A prompt while the main session still works on an earlier prompt with no answer yet drops nothing and keeps the first input.
  - A follow-up prompt less than 2 minutes after the last agent ended drops nothing: the agents, log and verdict stay, and the input box shows the new prompt.
  - A first agent that starts 2 minutes or more after the old run ended, with nothing running, drops the old agents and log but keeps the verdict and the input when they are newer than the old run's last agent (the prompt and the router both came before the spawn). An older verdict or input is dropped.

## Scrolling and resizing

- When the content is taller than the pane, a hint line at the top says the arrow keys scroll. They work once the pane has the keyboard: click it or type `/orchestration`. Esc returns to the prompt.
- The layout follows the pane width. The stage boxes sit 6 to a row from 100 columns, 3 from 40, 2 below that, with a return rail between rows. The slice columns stack top to bottom when they would be narrower than 14 cells each; otherwise they sit side by side.

## Sections, top to bottom

1. **Model legend.** One coloured square per model in use.
2. **Input box.** The first non-blank line of the prompt (cut to 120 characters), shown from the submit, with or without agents.
3. **Orchestrator box.** The orchestrator's model, a state line (dispatching with the count of running agents, signed off with N failed, passed with N fixed on the way, or all agents passed), and the agent count, total tokens and elapsed time. With no agents the state line reads "working in this session" while the main turn runs, then "answered in this session", or "stopped before an answer" when the main turn ended with a reason other than an answer.
4. **Triage box.** Shows the mode (plain, reviewed or orchestrate). Three sources:
   - A recorded route verdict, from the `route` tool or from a captured `npm run route`: the mode, the facts (files, lines, slices, risky, code) and the reason. The Bash capture happens only when the `/route` skill runs `npm run route` in a plain session, because `claude --agent orchestrator` has no Bash tool.
   - Otherwise, with agents, the mode is inferred from the agents (an implementer, integrator or plan review means orchestrate; a reviewer alone means reviewed; any other agent means orchestrate) and the box says "(inferred from the agents)". Under the orchestrator the triage is always inferred.
   - With no agents and no verdict, the box reads "sizing…" while the main turn runs, then the mode "plain" with "(inferred: no agents ran)".
5. **Pipeline stages.** Six boxes: triage, plan, plan review, build, review, merge. Each has a glyph, one coloured cell per task (the most recent that fit, then `+N`; dim dots when empty), and a line with done/total and the model families (the triage box shows the mode). Arrows join the boxes, with a dot moving along the arrow into a running stage. Between rows a return rail runs from the last box back to the first of the next row. The orchestrator plans itself, so the plan stage turns done (marked "orchestrator") once a plan review or a build has started. Merge reads "skipped" once the run is signed off with no integrator having run. Stages the mode does not use read "skipped" (plain: plan, plan review, review, merge; reviewed: plan, plan review, merge), and build reads "this session" while the main session does the work.
6. **Slice diagram.** One card per slice, in columns by dependency layer (a slice sits right of everything it waits for).
   - A rail on the left forks an arrowhead into every card of the first layer.
   - Routed box-drawing lines join each layer to the next, entering the target's middle with an arrowhead.
   - A dot travels along the edges whose target is running.
   - A bus under the diagram joins the final slices (those nothing depends on) into one arrow to the sign-off box.
   - A card shows the state glyph, slice id and time; build and review chips; the running agent's latest tool, else the token count or "queued"; and a `◀` line per dependency (up to 3, then "+N more"), green once satisfied. A dependency not yet launched appears as a queued card.
7. **Sign-off box.** "waiting for agents" until no agent is running, then the passed, failed and fixed counts. With no agents it reads "waiting for the reply", then "answered in this session" or "stopped". A failure counts as fixed (grey `◆`, "fixed by <slice>" in the tasks table) when a later slice that depends on the failed slice started after it ended and passed, or, for a plan review (no slice), when a later plan review passed. Fixed failures are not counted as failed in the stages or in the orchestrator box.
8. **Tasks table.** One row per slice (or per agent without a slice): glyph, label, a share bar, tokens, time, and a second line with the reported result (the report's `Answer:` line, else its first non-heading line; a bare `GAPS:` heading is skipped so the finding under it shows) or, while running, the latest tool. A totals line gives input, output and cache tokens.
9. **Usage by model.** One stacked bar, one segment per model with tokens, and a legend with tokens and percentage per model.
10. **Session log.** The last 10 events (7 on a narrow pane): time since the run began, a mark, what happened, duration and tokens. Triage verdicts are logged too.

A run with no agents (research or simple work that stays in the main session) shows the input box, the orchestrator box, the triage box, the stage boxes and the sign-off box; the tasks table, usage bar and slice diagram need agents. Arrows join the boxes in turn: input to orchestrator, orchestrator to triage, triage to the stage rows (after wrapped rows, the arrow comes after the last row), and the stages to the slice diagram or the sign-off box.

## Glyphs and colours

| Glyph | Meaning | Colour |
| --- | --- | --- |
| `●` or a spinner | running | amber |
| `✔` | passed | green |
| `✖` | failed | red |
| `◆` | finished with no STATUS line | grey |
| `◌` | queued | grey |

Flow lines are amber while work moves through them, green once what feeds them is done, grey before that. Models are coloured by family: opus magenta, sonnet yellow, haiku cyan, fable green, others white. Triage modes: plain grey, reviewed yellow, orchestrate cyan. A card is outlined with a double border for 2 seconds after an agent finishes.

## Where the data comes from

- The `SLICE:`, `FILES:` and `DEPENDS:` lines at the start of each agent brief give a slice's id, its file count and its dependencies. A brief starting with `PLAN REVIEW` is labelled "plan review".
- The `Agent` spawn event gives the role, model and start time. The turn-complete event gives the report (its last `STATUS: pass` or `STATUS: fail`; none means done), the token usage and the end time. Tool calls give a running agent's latest tool.
- The route verdict comes from the `route` tool, or from the result of a main-loop `npm run route` call.
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
- Headless runs (`npm run native`, `npm run auto`, the benchmark) have no screen and draw nothing.
- The stacked bar is at most 40 cells wide and at least 10, and each model with tokens needs one cell. It would overflow only with more such models than cells, which in practice means a very large number of distinct models.
