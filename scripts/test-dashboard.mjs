#!/usr/bin/env node
// Runs dashboard/register.test.tsx with `claude plugin test` against a copy of the built mod (dist/dashboard).
// Needs the `claude` CLI; without it the test is skipped (CI runs `npm run check`, which does not include this).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log("claude CLI not found; skipping the dashboard test");
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), "orch-dashboard-"));
cpSync(join(process.cwd(), "dist", "dashboard"), dir, { recursive: true });
cpSync(join(process.cwd(), "dashboard", "register.test.tsx"), join(dir, "hooks", "register.test.tsx"));
const r = spawnSync("claude", ["plugin", "test", dir], { stdio: "inherit" });
rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
