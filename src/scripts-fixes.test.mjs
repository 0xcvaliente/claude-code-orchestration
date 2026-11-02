// Regression tests for scripts/auto.sh (relative repo path) and scripts/report.mjs (legacy runs row).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

test("auto.sh passes an absolute --repo to route.ts when given a relative folder", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "auto-rel-")));
  try {
    mkdirSync(join(scratch, "proj"));
    mkdirSync(join(scratch, "bin"));
    // A fake npx records its arguments and prints a decision that forces the orchestrator route.
    writeFileSync(join(scratch, "bin", "npx"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${scratch}/npx-args"\necho '{"mode":"orchestrate","reason":"stub"}'\n`);
    chmodSync(join(scratch, "bin", "npx"), 0o755);
    const r = spawnSync("bash", [join(scripts, "auto.sh"), "task", "proj"], {
      cwd: scratch,
      env: { ...process.env, PATH: `${join(scratch, "bin")}:${process.env.PATH}`, ORCH_DRY_RUN: "1", ORCH_MODE: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const args = readFileSync(join(scratch, "npx-args"), "utf8").split("\n");
    assert.equal(args[args.indexOf("--repo") + 1], join(scratch, "proj"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("auto.sh exits 1 with 'repo folder not found' before any triage call when the repo folder does not exist", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "auto-missing-")));
  try {
    mkdirSync(join(scratch, "bin"));
    writeFileSync(join(scratch, "bin", "npx"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${scratch}/npx-args"\necho '{"mode":"orchestrate","reason":"stub"}'\n`);
    chmodSync(join(scratch, "bin", "npx"), 0o755);
    const r = spawnSync("bash", [join(scripts, "auto.sh"), "task", "nope"], {
      cwd: scratch,
      env: { ...process.env, PATH: `${join(scratch, "bin")}:${process.env.PATH}`, ORCH_DRY_RUN: "1", ORCH_MODE: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "" },
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /repo folder not found/);
    assert.ok(!existsSync(join(scratch, "npx-args")), "triage (npx) must not run for a missing folder");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("report.mjs writes a report for a legacy runs.jsonl row without subagents", () => {
  const repo = mkdtempSync(join(tmpdir(), "report-legacy-"));
  try {
    const state = join(repo, ".claude", "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "runs.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:00Z", task: "old", ok: true, cost_usd: 0.5 }) + "\n");
    const r = spawnSync("node", [join(scripts, "report.mjs"), repo], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(state, "report.html")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
