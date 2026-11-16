// scripts/orchestrate.sh dry run: --no-session-persistence by default, omitted with ORCH_SESSION_PERSISTENCE=1
// (so headless runs can keep subagent transcripts for telemetry v2's per-agent tokens, turns and models).
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const orchestrateSh = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "orchestrate.sh");

/** @param {Record<string, string>} env */
function dryRunArgs(env) {
  const repo = mkdtempSync(join(tmpdir(), "orch-sh-"));
  try {
    const r = spawnSync("bash", [orchestrateSh, "t", repo], {
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ORCH_SESSION_PERSISTENCE: "", ...env },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("orchestrate.sh dry run: --no-session-persistence by default and for any value but 1", () => {
  for (const v of ["", "0", "yes", "true"]) {
    assert.ok(dryRunArgs({ ORCH_SESSION_PERSISTENCE: v }).includes("--no-session-persistence"), `ORCH_SESSION_PERSISTENCE=${v}`);
  }
});

test("orchestrate.sh dry run: ORCH_SESSION_PERSISTENCE=1 omits --no-session-persistence and keeps the rest", () => {
  const def = dryRunArgs({});
  const kept = dryRunArgs({ ORCH_SESSION_PERSISTENCE: "1" });
  assert.ok(!kept.includes("--no-session-persistence"));
  assert.deepEqual(kept, def.filter((a) => a !== "--no-session-persistence"));
});

test("orchestrate.sh dry run: a plain session (ORCH_AGENT=none) unsets a folder's main agent; a named agent uses --agent", () => {
  // A folder's settings can name a main agent (this repo's .claude/settings.json does). The flag wins over it for a
  // named agent; a plain session passes an empty `agent` in the flag settings, which rank above the folder's.
  const plain = dryRunArgs({ ORCH_AGENT: "none" });
  assert.ok(!plain.includes("--agent"));
  assert.equal(plain[plain.indexOf("--settings") + 1], '{"agent":""}');
  assert.deepEqual(JSON.parse(plain[plain.indexOf("--settings") + 1] ?? "null"), { agent: "" });
  // --disallowedTools and --allowedTools take every word after them: the settings flag must come before both.
  assert.ok(plain.indexOf("--settings") < plain.indexOf("--disallowedTools") && plain.indexOf("--disallowedTools") < plain.indexOf("--allowedTools"));

  const named = dryRunArgs({ ORCH_AGENT: "reviewer", ORCH_AGENT_PREFIX: "orchestration:" });
  assert.equal(named[named.indexOf("--agent") + 1], "orchestration:reviewer");
  assert.ok(!named.includes("--settings"));
});
