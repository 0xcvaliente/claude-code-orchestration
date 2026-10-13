import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { UNSAFE_BASH } from "./config.js";

test("SDK worker deny list matches permissions.deny in .claude/settings.json", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  assert.deepEqual([...settings.permissions.deny].sort(), [...UNSAFE_BASH].sort());
});
