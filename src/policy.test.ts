import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DENIED_AGENTS, PUSH_BASH, SDK_DENIED_BASH, UNSAFE_BASH } from "./config.js";

test("SDK worker deny list plus the blocked built-in agents match permissions.deny in .claude/settings.json, except push", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  const shared = UNSAFE_BASH.filter((rule) => !PUSH_BASH.includes(rule));
  assert.deepEqual([...settings.permissions.deny].sort(), [...shared, ...DENIED_AGENTS].sort());
});

test("SDK workers can never push, while interactive sessions follow their permission mode", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  for (const rule of PUSH_BASH) {
    assert.ok(UNSAFE_BASH.includes(rule), `${rule} must stay in UNSAFE_BASH`);
    assert.ok(!settings.permissions.deny.includes(rule), `${rule} must not be in permissions.deny`);
  }
});

test("headless native runs disable Claude Code's built-in subagents", () => {
  const script = readFileSync(new URL("../scripts/orchestrate.sh", import.meta.url), "utf8");
  assert.match(script, /^export CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1$/m);
});

test("SDK_DENIED_BASH keeps sudo denied by rule and is a subset of UNSAFE_BASH (the native lists do not change)", () => {
  assert.deepEqual(SDK_DENIED_BASH, ["Bash(sudo*)"]);
  for (const rule of SDK_DENIED_BASH) assert.ok(UNSAFE_BASH.includes(rule));
});
