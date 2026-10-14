// routes.jsonl (src/route.ts) and the HTML report (scripts/report.mjs) follow the hooks' state-dir rule in
// .claude/hooks/state.mjs: a repo that registers its own hooks keeps .claude/state, a plugin install keeps its
// state in a per-user dir, never in the repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

// A clean environment: no plugin data dir or config dir from the machine running the tests.
const envWith = (env: Record<string, string>) => ({ ...process.env, CLAUDE_PLUGIN_DATA: "", CLAUDE_CONFIG_DIR: "", HOME: tmp("orch-home-"), ...env });

// --mode plain is a forced route: no model call.
const route = (repo: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(join(root, "node_modules", ".bin", "tsx"), [join(root, "src", "route.ts"), "--repo", repo, "--task", "t", "--mode", "plain", ...args], {
    cwd: root,
    env: envWith(env),
    encoding: "utf8",
  });
// The plugin copy of telemetry.mjs, run as hooks.json runs it.
const pluginTelemetry = (repo: string, data: string) =>
  spawnSync("node", [join(root, ".claude", "hooks", "telemetry.mjs"), "--plugin"], {
    input: JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s1", agent_type: "orchestration:implementer" }),
    env: envWith({ CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_DATA: data }),
    encoding: "utf8",
  });
const report = (repo: string, env: Record<string, string>) =>
  spawnSync("node", [join(root, "scripts", "report.mjs"), repo], { env: envWith(env), encoding: "utf8" });

// A repo that registers its own copy of the hooks, as this one does.
function withHooks(repo: string) {
  mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(repo, ".claude", "hooks", "telemetry.mjs"), "");
  writeFileSync(join(repo, ".claude", "settings.json"), readFileSync(join(root, ".claude", "settings.json")));
  return repo;
}

test("route: a repo without its own hooks logs routes.jsonl beside the plugin hooks' state, not in the repo", () => {
  const repo = tmp("orch-repo-");
  const data = tmp("orch-data-");
  assert.equal(pluginTelemetry(repo, data).status, 0);
  const r = route(repo, { CLAUDE_PLUGIN_DATA: data });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).mode, "plain");
  assert.equal(existsSync(join(repo, ".claude")), false, "nothing is written into the repo");
  const keys = readdirSync(join(data, "state"));
  assert.equal(keys.length, 1, `one dir for the hooks and the triager: ${keys.join(", ")}`);
  const dir = join(data, "state", keys[0] ?? "");
  assert.deepEqual(readdirSync(dir).sort(), ["routes.jsonl", "telemetry.jsonl"]);
  assert.match(readFileSync(join(dir, "routes.jsonl"), "utf8"), /"mode":"plain","source":"forced"/);

  // Without CLAUDE_PLUGIN_DATA, the same fallback as the hooks: ~/.claude/orchestration/state/<key>.
  const home = tmp("orch-home-");
  assert.equal(route(repo, { HOME: home }).status, 0);
  assert.deepEqual(readdirSync(join(home, ".claude", "orchestration", "state", keys[0] ?? "")), ["routes.jsonl"]);
});

test("route: a repo that registers its hooks, or --project-state (auto.sh), logs to .claude/state with a .gitignore", () => {
  const data = tmp("orch-data-");
  for (const [repo, args] of [
    [withHooks(tmp("orch-repo-")), []],
    [tmp("orch-repo-"), ["--project-state"]],
  ] as const) {
    const r = route(repo, { CLAUDE_PLUGIN_DATA: data }, ...args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(repo, ".claude", "state", "routes.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(repo, ".claude", "state", ".gitignore"), "utf8"), "*\n");
  }
  assert.equal(existsSync(join(data, "state")), false);
});

test("report: finds a plugin install's state in its plugin data dir from a terminal, and writes report.html there", () => {
  const repo = tmp("orch-repo-");
  const config = tmp("orch-config-");
  // Claude Code sets CLAUDE_PLUGIN_DATA for hooks and substitutes it into the /route skill; a terminal has neither.
  const data = join(config, "plugins", "data", "orchestration-some-marketplace");
  assert.equal(pluginTelemetry(repo, data).status, 0);
  assert.equal(route(repo, { CLAUDE_PLUGIN_DATA: data }).status, 0);
  const key = readdirSync(join(data, "state"))[0] ?? "";
  const other = join(config, "plugins", "data", "another-plugin", "state", key);
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "telemetry.jsonl"), "{}\n");

  const r = report(repo, { CLAUDE_CONFIG_DIR: config });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(0 runs, 1 events, 1 routes, 0 gates\)/);
  const html = readFileSync(join(data, "state", key, "report.html"), "utf8");
  assert.match(html, /orchestration:implementer/);
  assert.match(html, /<td>plain<\/td><td>forced<\/td>/);
  assert.equal(existsSync(join(repo, ".claude")), false, "nothing is written into the repo");
  assert.equal(existsSync(join(other, "report.html")), false, "another plugin's data dir is never read");
});

test("report: prefers .claude/state when it has telemetry, and falls back when it has none", () => {
  const data = tmp("orch-data-");
  const repo = tmp("orch-repo-");
  assert.equal(pluginTelemetry(repo, data).status, 0);
  const key = readdirSync(join(data, "state"))[0] ?? "";

  // Only a routes.jsonl in the repo (an older /route call): the plugin telemetry wins.
  mkdirSync(join(repo, ".claude", "state"), { recursive: true });
  writeFileSync(join(repo, ".claude", "state", "routes.jsonl"), `${JSON.stringify({ mode: "plain" })}\n`);
  assert.ok(report(repo, { CLAUDE_PLUGIN_DATA: data }).stdout.includes(`${join(data, "state", key, "report.html")} `));

  // Project telemetry (native mode or this repo): the project's state wins.
  writeFileSync(join(repo, ".claude", "state", "telemetry.jsonl"), `${JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s2" })}\n`);
  const r = report(repo, { CLAUDE_PLUGIN_DATA: data });
  assert.ok(r.stdout.includes(`${join(repo, ".claude", "state", "report.html")} (0 runs, 1 events, 1 routes`), r.stdout);
});
