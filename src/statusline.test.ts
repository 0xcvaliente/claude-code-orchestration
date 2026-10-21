import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../statusline/statusline.sh", import.meta.url));
const hasJq = spawnSync("jq", ["--version"]).status === 0;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("statusline shows model, folder, changed lines, rate limit and context fill", { skip: !hasJq && "jq not installed" }, () => {
  const input = JSON.stringify({
    model: { display_name: "Sonnet 5.5" },
    workspace: { current_dir: "/work/demo-project" },
    context_window: { used_percentage: 34.2 },
    cost: { total_lines_added: 3, total_lines_removed: 1 },
    rate_limits: { five_hour: { used_percentage: 4, resets_at: Math.floor(Date.now() / 1000) + 7300 } },
  });
  const r = spawnSync("bash", [script], { input, encoding: "utf8", cwd: "/" });
  assert.equal(r.status, 0, r.stderr);
  const out = plain(r.stdout);
  assert.match(out, /\[Sonnet 5\.5\] .* demo-project/);
  assert.match(out, /\+3 -1/);
  assert.match(out, /\[5h\] \(2h left\) .* 4%/);
  assert.match(out, /\[ctx\] .* 34%/);
});

test("statusline prints only the model line before any rate limit is reported", { skip: !hasJq && "jq not installed" }, () => {
  const input = JSON.stringify({ model: { display_name: "Opus" }, workspace: { current_dir: "/a/b" }, context_window: {}, cost: {} });
  const r = spawnSync("bash", [script], { input, encoding: "utf8", cwd: "/" });
  assert.equal(r.status, 0, r.stderr);
  const lines = plain(r.stdout).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? "", /^\[ctx\] .* 0%$/);
});
