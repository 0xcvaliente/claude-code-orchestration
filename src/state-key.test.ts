// .claude/hooks/state.mjs stateKey is the rule; verify.sh mirrors it in bash. Both must give the same key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stateKey } from "../.claude/hooks/state.mjs";

const sh = readFileSync(new URL("../.claude/hooks/verify.sh", import.meta.url), "utf8");
// The two lines of verify.sh that compute the key, taken verbatim so the test follows edits to the script.
const keyLines = sh.split("\n").filter((l) => /^\s*key="\$\(printf/.test(l) || /^\s*\[ "\$\{#key\}" -gt 200 \]/.test(l));

function bashKey(project: string): string {
  assert.equal(keyLines.length, 2, "could not find the key computation in .claude/hooks/verify.sh");
  const r = spawnSync("bash", ["-c", `project="$1"\n${keyLines.join("\n")}\nprintf '%s' "$key"`, "bash", project], { encoding: "utf8" });
  assert.equal(r.error, undefined, `bash is required for this test: ${r.error?.message}`);
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
  return r.stdout;
}

test("verify.sh and state.mjs compute the same state key", () => {
  const paths = [
    "/Users/me/projects/app",
    "/Users/me/my projects/the app",
    "/tmp/café/日本",
    "/tmp/" + "a".repeat(150) + "/" + "b".repeat(100),
    "/tmp/" + "日本".repeat(80),
    "/Users/me/app/",
    "/a/b.c_d-e",
  ];
  for (const p of paths) assert.equal(bashKey(p), stateKey(p), p);
  assert.equal(stateKey(paths[3] as string).length, 200);
});
