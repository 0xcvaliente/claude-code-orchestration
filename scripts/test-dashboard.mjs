#!/usr/bin/env node
// Runs dashboard/register.test.tsx with `claude plugin test` against a copy of the built mod (dist/dashboard) with the
// dashboard/ sources laid over it, so it tests the source, not the committed build. `claude plugin validate` runs first.
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
const src = join(process.cwd(), "dashboard");
cpSync(join(src, "register.tsx"), join(dir, "hooks", "register.tsx"));
cpSync(join(src, "types", "index.d.ts"), join(dir, "types", "index.d.ts"));
cpSync(join(src, "register.test.tsx"), join(dir, "hooks", "register.test.tsx"));
/** @param {number} code @returns {never} */
const done = (code) => {
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
};
const v = spawnSync("claude", ["plugin", "validate", dir], { encoding: "utf8" });
process.stdout.write(`${v.stdout ?? ""}${v.stderr ?? ""}`);
if (v.status !== 0) {
  console.error("claude plugin validate failed");
  done(v.status || 1);
}
console.log("claude plugin validate passed");
const r = spawnSync("claude", ["plugin", "test", dir], { stdio: "inherit" });
done(r.status ?? 1);
