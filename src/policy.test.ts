import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PUSH_BASH, UNSAFE_BASH } from "./config.js";

test("SDK worker deny list matches permissions.deny in .claude/settings.json, except push", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  const shared = UNSAFE_BASH.filter((rule) => !PUSH_BASH.includes(rule));
  assert.deepEqual([...settings.permissions.deny].sort(), [...shared].sort());
});

test("SDK workers can never push, while interactive sessions follow their permission mode", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  for (const rule of PUSH_BASH) {
    assert.ok(UNSAFE_BASH.includes(rule), `${rule} must stay in UNSAFE_BASH`);
    assert.ok(!settings.permissions.deny.includes(rule), `${rule} must not be in permissions.deny`);
  }
});
