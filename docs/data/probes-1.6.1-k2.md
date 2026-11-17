# Probes for 1.6.1, slice k2: is the prompt's own record in the transcript at UserPromptSubmit?

Date: 2026-11-17. Claude Code 2.1.326 on Linux. Two live probes, total cost 0.00103 USD.

Question: could `typedPrompt` (`.claude/hooks/state.mjs`) look up the record of the current prompt in `transcript_path`
and mark a prompt as not typed when that record says it came from somewhere else? That needs (a) the record of this very
prompt to be in the transcript when the hook fires, and (b) a field on that record (`origin`, `isMeta`) that differs
between a typed prompt and a wrapped message.

## Setup

A scratch folder `<scratch>` outside the repository, with:

- `<scratch>/hook.mjs`: a UserPromptSubmit hook that appends `{at, input, tail}` to `<scratch>/hook.log`, where `input`
  is the hook input and `tail` the last two non-empty lines of `input.transcript_path` (or `<unreadable: CODE>`).
- `<scratch>/settings.json`: `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node <scratch>/hook.mjs"}]}]}}`.
- Every run from `<scratch>/work` with `--setting-sources local --settings ../settings.json --strict-mcp-config`, so no
  user or project hook, plugin or MCP server loads.

## Probe 1: a typed prompt, at no cost

Command: `claude -p hi --model no-such-model-x --setting-sources local --settings ../settings.json --strict-mcp-config --max-budget-usd 0.01`

Cap: 0.01 USD. Result: exit 1, "There's an issue with the selected model (no-such-model-x)". Cost: 0 (no model call).

Seen: the hook fired before the model error. Input keys: `session_id`, `transcript_path`, `cwd`, `prompt_id`,
`permission_mode`, `hook_event_name`, `prompt` (`"hi"`). No origin-like field. `tail`: `<unreadable: ENOENT>`: at a
session's first prompt the transcript file does not exist yet.

## Probe 2: a typed prompt, then a task notification

Command: `claude -p 'Call the Bash tool once with command "sleep 3; echo probe-done" and run_in_background set to true. Then reply with the single word started. When the background task reports back, reply with the single word seen.' --model haiku --tools Bash --allowedTools Bash --setting-sources local --settings ../settings.json --strict-mcp-config --disable-slash-commands --max-budget-usd 0.05 --output-format json`

Cap: 0.05 USD. Result: `"result":"seen"`, `is_error: false`; the session's `cost-state` record says `totalCostUSD`
0.00103324 (haiku, 4,232 cache-write and 14,124 cache-read tokens). The background shell task's completion reached the
session as a new prompt, and `claude -p` waited for it here.

Seen at the hook:

| Prompt | Hook input | Transcript tail when the hook fired |
| --- | --- | --- |
| the typed prompt | the same seven keys; no origin field | `<unreadable: ENOENT>` (no file yet) |
| `<task-notification>\n<task-id>...` | the same seven keys; no origin field | a `queue-operation` `enqueue` record (its `content` is the notification text; keys `type, operation, timestamp, sessionId, content`) and a `queue-operation` `dequeue` record |

Seen in the transcript after the session (42 lines):

| Record | `promptId` | `isMeta` | `origin` | `promptSource` | `turnOrigin` |
| --- | --- | --- | --- | --- | --- |
| user record of the typed prompt | the first prompt's id | absent | absent | `sdk` | `sdk` |
| user record of the notification | the notification's `prompt_id` | absent | `{kind: "task-notification", producer: "session-task", runId}` | `system` | `task_notification` |

The notification's user record comes after the two queue records, so it was written after the hook ran.

## Answers

- (a) No. When UserPromptSubmit fires, the record of the current prompt is not in the transcript: at a session's first
  prompt the file does not exist, and at a task notification the last lines are the queue's enqueue and dequeue
  records, which carry no `promptId` and no origin. A lookup by `prompt_id` finds nothing; a lookup of the last user
  record finds the previous prompt's.
- (b) Partly. `isMeta` is absent on both user records. `origin`, `promptSource` and `turnOrigin` differ between the
  typed prompt and the notification, but only on the record written after the hook.

Since (a) does not hold, `typedPrompt` gets no transcript lookup: it keeps the opening-text rule (and the origin-like
fields of the hook input). Not probed: a message from another session (`<cross-session-message>`) and a background
subagent's hand-back; both arrive through the same queue on 2.1.326, but that was not observed here.
