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
// What orchestrate.sh pipes into log-run.mjs from the target folder after `claude -p --output-format json`.
const logRun = (repo: string) =>
  spawnSync("node", [join(root, "scripts", "log-run.mjs"), "headless task"], {
    cwd: repo,
    input: JSON.stringify({
      is_error: false,
      total_cost_usd: 0.5,
      num_turns: 3,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, // main loop only: ignored while modelUsage has entries
      modelUsage: {
        "claude-opus-4-7": { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 100000, cacheCreationInputTokens: 2000, costUSD: 0.4 },
        "claude-haiku-4-5": { inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 3000, cacheCreationInputTokens: 200, costUSD: 0.1 },
      },
      subagent_stats: { by_type: { "orchestration:implementer": 1 } },
    }),
    env: envWith({}),
    encoding: "utf8",
  });
// The plugin copy of verify.sh, run as hooks.json runs it when the plugin's implementer stops.
const pluginVerify = (repo: string, data: string) =>
  spawnSync("bash", [join(root, ".claude", "hooks", "verify.sh"), "--plugin"], {
    input: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s1", agent_type: "orchestration:implementer", agent_id: "a1", cwd: repo }),
    env: envWith({ CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_DATA: data, ORCH_TEST_CMD: "exit 0" }),
    encoding: "utf8",
  });

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

  // Only a routes.jsonl in the repo (an older /route call): report.html goes beside the plugin telemetry, and the
  // repo's routes are read too.
  mkdirSync(join(repo, ".claude", "state"), { recursive: true });
  writeFileSync(join(repo, ".claude", "state", "routes.jsonl"), `${JSON.stringify({ mode: "plain" })}\n`);
  const before = report(repo, { CLAUDE_PLUGIN_DATA: data });
  assert.ok(before.stdout.includes(`${join(data, "state", key, "report.html")} (0 runs, 1 events, 1 routes, 0 gates)`), before.stdout);
  assert.ok(before.stdout.includes(`also read routes.jsonl from ${join(repo, ".claude", "state")}`), before.stdout);

  // Project telemetry (native mode or this repo): the project's state wins.
  writeFileSync(join(repo, ".claude", "state", "telemetry.jsonl"), `${JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s2" })}\n`);
  const r = report(repo, { CLAUDE_PLUGIN_DATA: data });
  assert.ok(r.stdout.includes(`${join(repo, ".claude", "state", "report.html")} (0 runs, 1 events, 1 routes`), r.stdout);
});

test("report: a headless run with the plugin's agents shows the folder's runs and routes and the plugin hooks' events and gates", () => {
  const repo = tmp("orch-repo-");
  const config = tmp("orch-config-");
  const data = join(config, "plugins", "data", "orchestration-some-marketplace");
  // npm run auto in a folder without .claude/agents: auto.sh logs the route and log-run.mjs the run in the folder,
  // while the plugin's hooks log to its per-user dir.
  assert.equal(route(repo, { CLAUDE_PLUGIN_DATA: data }, "--project-state").status, 0);
  assert.equal(logRun(repo).status, 0);
  assert.equal(pluginTelemetry(repo, data).status, 0);
  assert.equal(pluginVerify(repo, data).status, 0);
  const own = join(repo, ".claude", "state");
  const user = join(data, "state", readdirSync(join(data, "state"))[0] ?? "");
  assert.deepEqual(readdirSync(own).sort(), [".gitignore", "routes.jsonl", "runs.jsonl"]);
  assert.deepEqual(readdirSync(user).sort(), ["gates.jsonl", "telemetry.jsonl"]);

  // From a terminal (no CLAUDE_PLUGIN_DATA): report.html stays beside runs.jsonl, as before, with all four logs.
  const r = report(repo, { CLAUDE_CONFIG_DIR: config });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`${join(own, "report.html")} (1 runs, 1 events, 1 routes, 1 gates)`), r.stdout);
  assert.ok(r.stdout.includes(`also read telemetry.jsonl, gates.jsonl from ${user}`), r.stdout);
  const logged = JSON.parse(readFileSync(join(own, "runs.jsonl"), "utf8").trim());
  assert.equal(logged.tokens, 107_000, "input + output + cache read + cache write over both models");
  assert.deepEqual(logged.usage, { input: 1200, output: 600, cacheRead: 103_000, cacheWrite: 2200 });
  assert.equal("cost_usd" in logged, false);
  const html = readFileSync(join(own, "report.html"), "utf8");
  assert.match(html, /<td>headless task<\/td><td>ok<\/td><td>107k<\/td>/);
  assert.match(html, /<th>Tokens<\/th>/);
  assert.doesNotMatch(html, /Cost USD|≈/);
  assert.match(html, /<td>plain<\/td><td>forced<\/td>/);
  assert.match(html, /Session s1.*<td>SubagentStart<\/td><td>orchestration:implementer<\/td>/);
  assert.match(html, /<td>test<\/td><td>allow<\/td><td>tests_passed<\/td>/);
  assert.ok(html.includes(`<code>${user}</code> (telemetry.jsonl, gates.jsonl)`), "the page says where each log came from");
  assert.equal(existsSync(join(user, "report.html")), false);

  // Once .claude/state has every log (a repo with its own hooks, like this one), nothing comes from the per-user dir.
  writeFileSync(join(own, "telemetry.jsonl"), `${JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s2", agent_type: "implementer" })}\n`.repeat(2));
  writeFileSync(join(own, "gates.jsonl"), `${JSON.stringify({ gate: "review", decision: "block", reason: "no_reviewer_after_last_implementer", session_id: "s2" })}\n`.repeat(2));
  const mine = report(repo, { CLAUDE_CONFIG_DIR: config });
  assert.ok(mine.stdout.includes(`${join(own, "report.html")} (1 runs, 2 events, 1 routes, 2 gates)`), mine.stdout);
  assert.doesNotMatch(mine.stdout, /also read/);
  const page = readFileSync(join(own, "report.html"), "utf8");
  assert.doesNotMatch(page, /Session s1|tests_passed/);
  assert.equal(page.includes(user), false);
});

test("report: a legacy runs.jsonl line with only cost_usd shows an estimate from list-price cost, with a note", () => {
  const repo = tmp("orch-repo-");
  mkdirSync(join(repo, ".claude", "state"), { recursive: true });
  const legacy = { ts: "t", task: "old task", ok: true, cost_usd: 0.5, duration_ms: 1, turns: 3, terminal_reason: "completed", subagents: {}, result: "" };
  writeFileSync(join(repo, ".claude", "state", "runs.jsonl"), `${JSON.stringify(legacy)}\n`);
  const r = report(repo, {});
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(repo, ".claude", "state", "report.html"), "utf8");
  assert.match(html, /<td>old task<\/td><td>ok<\/td><td>≈500k<\/td>/);
  assert.match(html, /≈ marks runs logged before token tracking/);
});
