// The caps of 2.1.0 have one home in code, .claude/hooks/limits.mjs: slices per plan, researcher questions per run and
// implementers running at once (with its maintainer switch). These cases pin the values and the reading of the switch;
// a prose or script copy of a value is pinned to this module by the test that reads that copy.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as limits from "../.claude/hooks/limits.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the caps: 12 slices per plan, 6 researcher questions per run, 4 implementers at once with a ceiling of 8", () => {
  assert.equal(limits.PLAN_SLICE_CAP, 12);
  assert.equal(limits.RESEARCH_QUESTION_CAP, 6);
  assert.equal(limits.WAVE_CAP_DEFAULT, 4);
  assert.equal(limits.WAVE_CAP_CEILING, 8);
});

test("the wave cap reads the maintainer switch as a whole number from 1 to 8; anything else counts as unset", () => {
  for (let n = 1; n <= 8; n++) assert.equal(limits.waveMax({ ORCH_WAVE_MAX: String(n) }), n, `ORCH_WAVE_MAX=${n}`);
  assert.equal(limits.waveMax({ ORCH_WAVE_MAX: " 3 " }), 3, "surrounding spaces are not part of the number");
  for (const bad of ["0", "9", "10", "-1", "2.5", "1e1", "abc", "", "  ", "0x4", "+3", "3 4"]) assert.equal(limits.waveMax({ ORCH_WAVE_MAX: bad }), 4, `ORCH_WAVE_MAX=${JSON.stringify(bad)}`);
  assert.equal(limits.waveMax({}), 4, "unset");
  // Environment only: the plugin option of the same name is not read.
  assert.equal(limits.waveMax({ CLAUDE_PLUGIN_OPTION_WAVE_MAX: "2" }), 4, "no plugin setting");
});

test("limits.mjs names nothing the frozen SDK pipeline's LIMITS could be mistaken for, and imports nothing", () => {
  const src = readFileSync(join(root, ".claude", "hooks", "limits.mjs"), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m, "no import: the module loads alone in every copy of the hooks");
  for (const name of Object.keys(limits)) {
    assert.notEqual(name, "LIMITS");
    assert.doesNotMatch(name, /^(concurrency|maxRetries|maxSlices|maxQuestions)$/, name);
  }
  // src/config.ts keeps its own values for the SDK pipeline (frozen since 0.3.0).
  const config = readFileSync(join(root, "src", "config.ts"), "utf8");
  assert.match(config, /maxSlices: 6,/);
  assert.match(config, /maxQuestions: 4,/);
});
