// scripts/orchestrate.sh dry run: --no-session-persistence by default, omitted with ORCH_SESSION_PERSISTENCE=1
// (so headless runs can keep subagent transcripts for telemetry v2's per-agent tokens, turns and models).
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const orchestrateSh = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "orchestrate.sh");

// One folder for every dry run here (the test root removes it): since 1.6.1 the git -C write rules name the repo folder,
// so two runs compare equal only in the same folder.
const dryRepo = mkdtempSync(join(tmpdir(), "orch-sh-"));
/** @param {Record<string, string>} env */
function dryRunArgs(env) {
  const repo = dryRepo;
  {
    const r = spawnSync("bash", [orchestrateSh, "t", repo], {
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ORCH_SESSION_PERSISTENCE: "", ...env },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\n");
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
  // The same settings JSON asks for the built-in Concise output style (audit O-5); ORCH_OUTPUT_STYLE=default drops it.
  assert.equal(plain[plain.indexOf("--settings") + 1], '{"agent":"","outputStyle":"Concise"}');
  assert.deepEqual(JSON.parse(plain[plain.indexOf("--settings") + 1] ?? "null"), { agent: "", outputStyle: "Concise" });
  const unstyled = dryRunArgs({ ORCH_AGENT: "none", ORCH_OUTPUT_STYLE: "default" });
  assert.equal(unstyled[unstyled.indexOf("--settings") + 1], '{"agent":""}');
  // --disallowedTools and --allowedTools take every word after them: the settings flag must come before both.
  assert.ok(plain.indexOf("--settings") < plain.indexOf("--disallowedTools") && plain.indexOf("--disallowedTools") < plain.indexOf("--allowedTools"));

  const named = dryRunArgs({ ORCH_AGENT: "reviewer", ORCH_AGENT_PREFIX: "orchestration:" });
  assert.equal(named[named.indexOf("--agent") + 1], "orchestration:reviewer");
  assert.ok(!named.includes("--settings"));
});

/** The allow rules: every argument after --allowedTools (variadic, kept last). @param {string[]} args */
const allowed = (args) => args.slice(args.indexOf("--allowedTools") + 1).filter((a) => a !== "");

test("orchestrate.sh dry run: the integrator's last-resort `git reset --merge` is allowed, and only that form of git reset", () => {
  const rules = allowed(dryRunArgs({}));
  assert.ok(rules.includes("Bash(git reset --merge)"), rules.join("\n"));
  const resets = rules.filter((r) => /^Bash\(git\s+(reset|\*)/.test(r));
  assert.deepEqual(resets, ["Bash(git reset --merge)"], "no rule allows the whole git reset family");
});

test("orchestrate.sh dry run: a relative repo path, started from its parent folder, finds the repo's own test runner", () => {
  const parent = mkdtempSync(join(tmpdir(), "orch-sh-rel-"));
  try {
    mkdirSync(join(parent, "proj"));
    writeFileSync(join(parent, "proj", "Cargo.toml"), "[package]\nname = \"p\"\n");
    const r = spawnSync("bash", [orchestrateSh, "t", "proj"], {
      cwd: parent,
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ORCH_SESSION_PERSISTENCE: "" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const rules = allowed(r.stdout.split("\n"));
    assert.ok(rules.includes("Bash(cargo test*)"), rules.join("\n"));
    assert.ok(rules.includes("Bash(cargo build*)"), rules.join("\n"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("orchestrate.sh: a repo folder that does not exist is still an error", () => {
  const parent = mkdtempSync(join(tmpdir(), "orch-sh-rel-"));
  try {
    const r = spawnSync("bash", [orchestrateSh, "t", "missing"], {
      cwd: parent,
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "" },
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
