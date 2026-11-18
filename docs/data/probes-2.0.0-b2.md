# Probes for 2.0.0, slice b2 (2026-11-17)

Two live proofs for items 1.6.1 listed as "not shown live": the worker rows the mod draws under the prompt in a real interactive session, and the sandbox `allowWrite` entry for the per-user orchestration folder. Claude Code 2.1.326, Linux. `<worktree>` is the slice's checkout of the repo; `<scratch>` is a scratch folder outside it.

Total paid cost: **0.0354 USD** (probe 1; probe 2 makes no model call). Limit: 0.70 USD.

## Probe 1: worker rows in an interactive session

### Setup

- Scratch project `<scratch>/p1` holding `note.txt` ("hello probe file") and three agent files in `.claude/agents/`:
  - `researcher.md` and `implementer.md`: copies of `<worktree>/.claude/agents/` with `model: haiku` (and the implementer's `effort: low`), the `skills:` list dropped. Their types are plain `researcher` and `implementer`, which the mod's `workerRole` takes as this plugin's roles.
  - `note-reader.md`: a project agent that is not this plugin's (`model: haiku`, tools `Read`). Used as "the other agent" so no agent type of Claude Code's own had to be named.
- `<scratch>/probe-settings.json`: `{"enabledPlugins":{"orchestration@claude-code-orchestration":false,"brain@claude-code-memory":false},"disableClaudeAiConnectors":true,"agent":""}`. This turns off the installed copy of the plugin, so the only mod drawing rows is the worktree's `dist/dashboard`, and keeps account connectors and the person's other plugin out of the session.

### Command

```
tmux new-session -d -s probe -x 200 -y 50 -c <scratch>/p1 \
  "claude --model haiku --strict-mcp-config --settings <scratch>/probe-settings.json --plugin-dir <worktree>/dist/dashboard"
```

Prompts sent with `tmux send-keys -t probe -l '<text>'` then `tmux send-keys -t probe Enter`; the screen captured every 0.5 s with `tmux capture-pane -p -t probe` for 40 to 50 s.

### Bound

Haiku for the session and every subagent; each subagent task one file read (three Read calls); one session of about 3 minutes in all (3m 8s wall as `/cost` reported), then `tmux kill-session -t probe`. Afterwards `tmux ls` printed `no server running` and `pgrep -fa "claude .*--plugin-dir"` found no session.

The session opened with no trust or login dialog (prompt ready, "auto mode on").

### Run A: pane off (the default at session start)

Prompt (summary): launch in parallel `researcher` with the brief `SLICE: p1 / FILES: none / GOAL: read note.txt three times, one Read call per turn, then reply with its first word.` and `note-reader` with `Read note.txt three times, one Read call per turn.`

A first attempt with a single read per agent finished in about 7 s, before the capture loop had started; no row was captured from it. The second prompt above was captured.

Rows under the prompt, quoted exactly (trailing spaces trimmed):

```
  ● main
  ◯ researcher p1 · haiku · 0 (0%) · Read note.txt three times
  ◯ note-reader  Read note.txt three times                                                                                                                                          0s
```

a few seconds later:

```
  ● main
  ◯ researcher p1 · haiku · 18.0k (2%) · Read note.txt three times
  ◯ note-reader  Read note.txt three times                                                                                                                                          3s · ↓ 3.3k tokens
```

### Run B: pane on (`/orchestration on`, same session)

The command answered `Orchestration pane is on: arrow keys scroll, Esc returns to the prompt.` and the pane opened beside the chat. Prompt (summary): launch in parallel two `implementer` agents with the same brief `SLICE: p2 / FILES: none / DEPENDS: none / GOAL: read note.txt three times, one Read call per turn, change nothing, then reply STATUS: pass.` and one `note-reader`.

Rows, quoted exactly (one frame):

```
  ● main
  ◯ implementer p2 · haiku · 31.2k (3%) · Read note.txt three times (p2)
  ◯ implementer p2 #2 · haiku · 31.3k (3%) · Read note.txt three times (p2)
  ◯ note-reader  Read note.txt three times                                                                                                                                          6s · ↓ 3.5k tokens
```

### Verdict

- This plugin's rows are drawn by the mod in the live engine, pane off and pane on alike: `<role> <slice> [#<attempt>] · <model> · <tokens> (<context %>) · <label>`. The attempt shows as `#2` on the second implementer of a slice and is left out on a first attempt and for other roles, as `workerRow` intends. The `AgentRow` props the hook reads (`type`, `id`, `model`, `tokenCount`, `contextWindowSize`, `label`, `columns`) arrive as on the test host; the token count starts at `0 (0%)` and follows the engine's five-second refresh.
- The other agent's row is Claude Code's own: name, label, and the elapsed time and `↓ tokens` columns at the right edge.
- No change to `dashboard/register.tsx` was needed.

### Cost

`/cost` at the end of the session: `Estimated cost: $0.0354`; `claude-haiku-5-5: 1.3k input, 7.2k output, 788.8k cache read, 156.1k cache write ($0.0354)`.

## Probe 2: sandbox write to the orchestration folder

### Check

`ls /usr/bin/bwrap /usr/bin/socat 2>/dev/null` printed only `/usr/bin/bwrap`: **`socat` is missing**, so Claude Code's sandbox cannot run on this machine and `scripts/sandbox-smoke.mjs` was not run. Whether a sandboxed command can write into `<config dir>/orchestration/skill-drafts/` without and with the entry stays unshown live.

What was proven without a sandbox: the `sandbox` check of `scripts/claude-update.mjs` on a scratch config folder.

### Setup

`<scratch>/cfg/settings.json`:

```
{ "model": "haiku", "permissions": { "allow": ["Read"] },
  "sandbox": { "enabled": true, "filesystem": { "allowWrite": ["~/work"] } } }
```

### Commands and output

`CLAUDE_CONFIG_DIR=<scratch>/cfg node scripts/claude-update.mjs` (run from `<worktree>`), exit 0:

```
  note   sandbox: the sandbox is on in <scratch>/cfg/settings.json and sandbox.filesystem.allowWrite does not cover <scratch>/cfg/orchestration, where this repo keeps its state, skill drafts and the judge's record: add "<scratch>/cfg/orchestration" to sandbox.filesystem.allowWrite, or run with --fix
```

`CLAUDE_CONFIG_DIR=<scratch>/cfg node scripts/claude-update.mjs --fix`, exit 0:

```
  fixed  sandbox: added "<scratch>/cfg/orchestration" to sandbox.filesystem.allowWrite in <scratch>/cfg/settings.json; restart Claude Code
```

The settings file afterwards keeps `model`, `permissions.allow: ["Read"]`, `sandbox.enabled: true` and the earlier `~/work` entry, with the new entry added once after it:

```
"allowWrite": ["~/work", "<scratch>/cfg/orchestration"]
```

`CLAUDE_CONFIG_DIR=<scratch>/cfg node scripts/claude-update.mjs` again, exit 0:

```
  ok     sandbox: the sandbox is on and sandbox.filesystem.allowWrite covers <scratch>/cfg/orchestration
```

Every other check line was the same in all three runs (cli, builtins, headless, flags, sdk ok; plugin a note, as the scratch config has no plugin installed; dist ok). `--fix` changed no plugin install, since none is listed in the scratch config.

### Cost

None: no model call.
