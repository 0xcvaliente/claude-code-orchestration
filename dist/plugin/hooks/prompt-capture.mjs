#!/usr/bin/env node
// UserPromptSubmit hook (no matcher): records what the user typed, the only authority the native Bash judge
// (judge-hook.mjs) accepts. Opt-in: it does nothing unless ORCH_JUDGE=native. Never blocks: always exit 0.
// Appends {ts, session_id, prompt_id, text (first 2000 chars)} to prompts.jsonl in the state dir. Prompts that do not
// come from the person (a task notification, a peer or system message) are skipped: an origin-like field with such a
// value, or a text that opens with such a tag. When the origin is unknown, the prompt is kept.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const ORIGIN_KEYS = ["origin", "prompt_origin", "prompt_source", "source", "kind", "prompt_kind", "sender"];
const NOT_PERSON = /notification|system|peer|agent|teammate|hook|tool|background|scheduled|cron|automat|bot/i;
const NOT_PERSON_TAG = /^\s*<(task-notification|system-reminder|teammate-message|peer-message|agent-message|channel-message)\b/i;

/** @param {any} input @param {string} text */
function fromPerson(input, text) {
  for (const key of ORIGIN_KEYS) {
    const v = input[key];
    const value = typeof v === "string" ? v : typeof v?.kind === "string" ? v.kind : typeof v?.type === "string" ? v.type : "";
    if (value && NOT_PERSON.test(value)) return false;
  }
  return !NOT_PERSON_TAG.test(text);
}

try {
  if ((process.env.ORCH_JUDGE ?? "").trim().toLowerCase() === "native" && process.env.ORCH_JUDGE_INNER !== "1" && !duplicate("prompt-capture.mjs")) {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const text = input?.prompt;
    if (typeof input?.session_id === "string" && typeof text === "string" && text.trim() && fromPerson(input, text)) {
      const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : randomUUID();
      ensureStateDir();
      const rec = { ts: new Date().toISOString(), session_id: input.session_id, prompt_id: promptId, text: text.slice(0, 2000) };
      appendFileSync(join(stateDir, "prompts.jsonl"), `${JSON.stringify(rec)}\n`);
    }
  }
} catch {
  // Malformed input or a failed write: no record, and the prompt goes through.
}
process.exit(0);
