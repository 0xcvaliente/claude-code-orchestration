# Live dashboard

The live dashboard is a pane beside the chat that draws an orchestration run while it happens. It is a Claude Code function-hooks mod; its source is `dashboard/register.tsx`. This page states what that code does.

## Opening it

- The pane opens when the first orchestration agent (researcher, implementer, reviewer or integrator) starts, and again when the result of the `/route` skill's `npm run route` command is captured.
- `/orchestration` opens it focused, so the arrow keys work at once.
- A pane nobody asked for seats only from 144 columns. On a narrower terminal a toast (shown once per run) says to type `/orchestration`.
- A new agent that starts with nothing running and the last agent finished over two minutes earlier begins a new run: the old diagram is dropped.

## Scrolling and resizing

- When the content is taller than the pane, a hint line at the top says the arrow keys scroll. They work once the pane has the keyboard: click it or type `/orchestration`. Esc returns to the prompt.
- The layout follows the pane width. The stage boxes sit 6 to a row from 100 columns, 3 from 40, 2 below that, with a return rail between rows. The slice columns stack top to bottom when they would be narrower than 14 cells each; otherwise they sit side by side.

## Sections, top to bottom

1. **Model legend.** One coloured square per model in use.
2. **Orchestrator box.** The orchestrator's model, a state line (dispatching with the count of running agents, signed off with N failed, or all agents passed), and the agent count, total tokens and elapsed time.
3. **Triage box.** Shows the mode (plain, reviewed or orchestrate). Two sources:
   - A captured route verdict: the mode, the facts (files, lines, slices, risky, code) and the reason. Capture happens only when the `/route` skill runs `npm run route` in a plain session, because `claude --agent orchestrator` has no Bash tool.
   - Otherwise the mode is inferred from the agents (an implementer, integrator or plan review means orchestrate; a reviewer alone means reviewed; any other agent means orchestrate) and the box says "(inferred from the agents)". Under the orchestrator the triage is always inferred.
4. **Pipeline stages.** Six boxes: triage, plan, plan review, build, review, merge. Each has a glyph, one coloured cell per task (the most recent that fit, then `+N`; dim dots when empty), and a line with done/total and the model families (the triage box shows the mode). Arrows join the boxes, with a dot moving along the arrow into a running stage. Between rows a return rail runs from the last box back to the first of the next row.
5. **Slice diagram.** One card per slice, in columns by dependency layer (a slice sits right of everything it waits for).
   - A rail on the left forks an arrowhead into every card of the first layer.
   - Routed box-drawing lines join each layer to the next, entering the target's middle with an arrowhead.
   - A dot travels along the edges whose target is running.
   - A bus under the diagram joins the final slices (those nothing depends on) into one arrow to the sign-off box.
   - A card shows the state glyph, slice id and time; build and review chips; the running agent's latest tool, else the token count or "queued"; and a `◀` line per dependency (up to 3, then "+N more"), green once satisfied. A dependency not yet launched appears as a queued card.
6. **Sign-off box.** "waiting for agents" until no agent is running, then the passed and failed counts.
7. **Tasks table.** One row per slice (or per agent without a slice): glyph, label, a share bar, tokens, time, and a second line with the reported result (the report's `Answer:` line, else its first non-heading line) or, while running, the latest tool. A totals line gives input, output and cache tokens.
8. **Usage by model.** One stacked bar, one segment per model with tokens, and a legend with tokens and percentage per model.
9. **Session log.** The last 10 events (7 on a narrow pane): time since the run began, a mark, what happened, duration and tokens. Triage verdicts are logged too.

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
- The route verdict comes from the result of a main-loop `npm run route` call.

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
