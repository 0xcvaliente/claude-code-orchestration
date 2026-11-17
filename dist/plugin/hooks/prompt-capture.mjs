#!/usr/bin/env node
// UserPromptSubmit hook (no matcher): records what the user typed, the only authority the native Bash judge
// (judge-hook.mjs) accepts. Opt-in: it does nothing unless ORCH_JUDGE=native. Never blocks: always exit 0.
// Appends {ts, session_id, prompt_id, text (first 2000 chars)} to prompts.jsonl in the per-user prompt store
// (state.mjs `promptStore`: <config dir>/orchestration/judge-prompts/<project key>, outside the project, so the judged
// worker's own folder never holds its judge's authority). Prompts that do not come from the person (a task notification,
// a subagent's report, a peer or system message) are skipped by `typedPrompt` in state.mjs, which nudge.mjs shares.
// When the origin is unknown, the prompt is kept.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { duplicate, promptStore, typedPrompt } from "./state.mjs";

try {
  if ((process.env.ORCH_JUDGE ?? "").trim().toLowerCase() === "native" && process.env.ORCH_JUDGE_INNER !== "1" && !duplicate("prompt-capture.mjs")) {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const text = input?.prompt;
    if (typeof input?.session_id === "string" && typeof text === "string" && text.trim() && typedPrompt(input)) {
      const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : randomUUID();
      mkdirSync(dirname(promptStore), { recursive: true, mode: 0o700 });
      const rec = { ts: new Date().toISOString(), session_id: input.session_id, prompt_id: promptId, text: text.slice(0, 2000) };
      appendFileSync(promptStore, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    }
  }
} catch {
  // Malformed input or a failed write: no record, and the prompt goes through.
}
process.exit(0);
