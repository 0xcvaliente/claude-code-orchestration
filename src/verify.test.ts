import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const testCmdSh = join(root, ".claude", "hooks", "test-cmd.sh");
const verifySh = join(root, ".claude", "hooks", "verify.sh");
const orchestrateSh = join(root, "scripts", "orchestrate.sh");

const tmp = () => mkdtempSync(join(tmpdir(), "orch-vt-"));
function detect(files: Record<string, string>, env: Record<string, string> = {}) {
  const dir = tmp();
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const r = spawnSync("bash", ["-c", `source "${testCmdSh}"; orch_detect_test_cmd "${dir}"`], {
    env: { ...process.env, ORCH_TEST_CMD: "", ...env },
    encoding: "utf8",
  });
  return r.stdout.trim();
}
const rules = (cmd: string) =>
  spawnSync("bash", ["-c", `source "${testCmdSh}"; orch_allow_rules "$1"`, "x", cmd], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);

test("detect: each runner, and nothing for an empty project", () => {
  assert.equal(detect({ "package.json": '{"scripts":{"test":"x"}}' }), "npm test --silent");
  assert.match(detect({ "pyproject.toml": "", "tests/test_a.py": "" }), /^python3 -m (pytest -q|unittest discover -q)$/);
  assert.match(detect({ "pkg/foo_test.py": "" }), /^python3 -m /);
  assert.match(detect({ "tests/test_a.py": "" }), /^python3 -m /);
  assert.equal(detect({ "Cargo.toml": "" }), "cargo test --quiet");
  assert.equal(detect({ "go.mod": "" }), "go test ./...");
  assert.equal(detect({ "Package.swift": "" }), "swift test");
  assert.equal(detect({ Makefile: "test:\n\ttrue\n" }), "make test");
  assert.equal(detect({ Makefile: "build:\n\ttrue\n" }), "");
  assert.equal(detect({}), "");
  assert.equal(detect({ "go.mod": "" }, { ORCH_TEST_CMD: "custom run" }), "custom run");
});

test("allow rules per runner", () => {
  assert.deepEqual(rules("python3 -m pytest -q"), ["Bash(python3 -m pytest*)", "Bash(pytest*)"]);
  assert.deepEqual(rules("python3 -m unittest discover -q"), ["Bash(python3 -m unittest*)"]);
  assert.deepEqual(rules("cargo test --quiet"), ["Bash(cargo test*)", "Bash(cargo build*)"]);
  assert.deepEqual(rules("go test ./..."), ["Bash(go test*)", "Bash(go build*)", "Bash(go vet*)"]);
  assert.deepEqual(rules("swift test"), ["Bash(swift test*)", "Bash(swift build*)"]);
  assert.deepEqual(rules("make test"), ["Bash(make test*)"]);
  assert.deepEqual(rules("npm test --silent"), []);
  assert.deepEqual(rules("custom run"), ["Bash(custom run*)"]);
});

function verify(env: Record<string, string>) {
  const project = tmp();
  const cwd = join(project, ".claude", "worktrees", "x");
  mkdirSync(cwd, { recursive: true });
  const r = spawnSync("bash", [verifySh], {
    input: JSON.stringify({ agent_type: "implementer", agent_id: "a1", cwd }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, ORCH_TEST_CMD: "exit 1", ...env },
    encoding: "utf8",
  });
  const log = readFileSync(join(project, ".claude", "state", "gates.jsonl"), "utf8");
  return { status: r.status, log };
}

test("verify.sh in an isolated worktree: warn by default, block on request, skip on request", () => {
  const warn = verify({});
  assert.equal(warn.status, 0);
  assert.match(warn.log, /"decision":"warn".*"reason":"tests_failed_isolated"/);
  assert.equal(verify({ ORCH_GATE_ISOLATED: "block" }).status, 2);
  const skip = verify({ ORCH_GATE_ISOLATED: "skip" });
  assert.equal(skip.status, 0);
  assert.match(skip.log, /"decision":"allow".*"reason":"isolated_skipped"/);
});

test("orchestrate.sh dry run: runner rules, --model and extra rules", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
  writeFileSync(join(repo, "pyproject.toml"), "");
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "tests", "test_a.py"), "");
  const run = (env: Record<string, string>) =>
    spawnSync("bash", [orchestrateSh, "t", repo], {
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ...env },
      encoding: "utf8",
    });
  const base = run({});
  assert.equal(base.status, 0);
  assert.match(base.stdout, /Bash\(python3 -m (pytest|unittest)\*\)/);
  assert.doesNotMatch(base.stdout, /--model/);
  assert.ok(base.stdout.split("\n").includes("SendMessage"), "headless orchestrator retries need SendMessage to resume the implementer");
  const full = run({ ORCH_MODEL: "sonnet", ORCH_EXTRA_ALLOWED_TOOLS: "Bash(ruff*)\n\nBash(mypy*)" });
  const lines = full.stdout.split("\n");
  assert.equal(lines[lines.indexOf("--model") + 1], "sonnet");
  assert.ok(lines.includes("Bash(ruff*)") && lines.includes("Bash(mypy*)"));
  assert.ok(lines.indexOf("--allowedTools") > lines.indexOf("--model"), "--allowedTools stays last");
});

test("orchestrate.sh dry run: ORCH_BUDGET_TOKENS becomes --max-budget-usd, a bad count or the old dollar name exits 1", () => {
  const repo = tmp();
  const run = (env: Record<string, string>) =>
    spawnSync("bash", [orchestrateSh, "t", repo], {
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ...env },
      encoding: "utf8",
    });
  const cap = (env: Record<string, string>) => {
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split("\n");
    return lines.includes("--max-budget-usd") ? lines[lines.indexOf("--max-budget-usd") + 1] : undefined;
  };
  assert.equal(cap({ ORCH_BUDGET_TOKENS: "2M" }), "2");
  assert.equal(cap({ ORCH_BUDGET_TOKENS: "500k" }), "0.5");
  assert.equal(cap({}), undefined);
  for (const bad of ["5", "abc"]) {
    const r = run({ ORCH_BUDGET_TOKENS: bad });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`ORCH_BUDGET_TOKENS must be a token count of at least 10k, such as 500000, 500k or 2M \\(got ${bad}\\)`));
    assert.equal(r.stdout, "");
  }
  const old = run({ ORCH_BUDGET_USD: "5" });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /ORCH_BUDGET_USD was replaced by ORCH_BUDGET_TOKENS \(a token count such as 2M\)/);
  assert.equal(old.stdout, "");
});

test("auto.sh: a set ORCH_BUDGET_USD or a bad ORCH_BUDGET_TOKENS exits 1 before triage or any model call", () => {
  const repo = withAgents(tmp());
  const t = fakeTools({ session: '{"result":"must not run"}', route: { mode: "plain", source: "forced", reason: "stub", tokens: 0 } });
  for (const [env, message] of [
    [{ ORCH_BUDGET_USD: "5" }, /ORCH_BUDGET_USD was replaced by ORCH_BUDGET_TOKENS \(a token count such as 2M\)/],
    [{ ORCH_BUDGET_TOKENS: "abc" }, /ORCH_BUDGET_TOKENS must be a token count of at least 10k, such as 500000, 500k or 2M \(got abc\)/],
  ] as const) {
    const r = runAuto(repo, t.bin, { ORCH_BUDGET_USD: "", ORCH_BUDGET_TOKENS: "", ...env });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stderr, /^route:/m, "the fake route tool was not called");
    assert.equal(r.stdout, "");
  }
  assert.equal(t.calls().length, 0, "no model call");
});

test("auto.sh reviewed route: the reviewer gets the detected runner's rules and no broader Bash", () => {
  const repo = withAgents(tmp());
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "tests", "test_a.py"), "");
  // A fake claude records its arguments, one call per file, and answers STATUS: pass.
  const bin = tmp();
  const log = join(bin, "calls");
  mkdirSync(log);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}/$$"\necho '{"result":"STATUS: pass"}'\n`, { mode: 0o755 });
  const r = spawnSync("bash", [join(root, "scripts", "auto.sh"), "t", repo], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCH_MODE: "reviewed", ORCH_TEST_CMD: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  // auto.sh keeps the decision beside runs.jsonl, though this repo does not register the hooks.
  assert.match(readFileSync(join(repo, ".claude", "state", "routes.jsonl"), "utf8"), /"mode":"reviewed"/);
  const calls = readdirSync(log).map((f) => readFileSync(join(log, f), "utf8"));
  const reviewer = calls.find((c) => c.includes("--agent\nreviewer"));
  assert.ok(reviewer, "reviewer call recorded");
  assert.match(reviewer, /^Bash\(python3 -m (pytest|unittest)\*\)$/m);
  assert.match(reviewer, /^Bash\(git diff\*\)$/m);
  assert.doesNotMatch(reviewer, /^(Edit|Write|Bash\(git add\*\)|Bash\(npm \*\))$/m);
});

const autoSh = join(root, "scripts", "auto.sh");
const WRITES = /^(Edit|Write|Bash\(git add\*\)|Bash\(npm \*\))$/m;

/** The installed plugins as `claude plugin list --json` prints them, with the orchestration plugin enabled. */
const PLUGIN_ON = JSON.stringify([
  { id: "orchestration@claude-code-orchestration", version: "0.1.5", scope: "user", enabled: true, projectEnabled: false },
]);

/**
 * A bin dir for PATH with a fake `claude` and, when `route` is given, a fake `npx` that answers auto.sh's route step with
 * that decision instead of calling a model. The fake claude records each model call's arguments (one file per call),
 * answers a reviewer call (`reviewer` or a namespaced `<plugin>:reviewer`) with `reviewer` (default: STATUS: pass) and
 * any other call with the contents of session.out. `claude plugin list --json` prints `plugins` (default `[]`: no
 * plugins; null: the command fails) and records the folder it ran in, apart from the model calls.
 */
function fakeTools(opts: { session: string; sessionExit?: number; route?: object; reviewer?: string; plugins?: string | null }) {
  const bin = tmp();
  const log = join(bin, "calls");
  mkdirSync(log);
  writeFileSync(join(bin, "session.out"), opts.session);
  writeFileSync(join(bin, "reviewer.out"), opts.reviewer ?? '{"result":"STATUS: pass"}');
  if (opts.plugins !== null) writeFileSync(join(bin, "plugins.out"), opts.plugins ?? "[]");
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `if [ "$1" = plugin ]; then`,
      `  pwd -P >> "${bin}/plugin-list.cwd"`,
      `  [ "$*" = "plugin list --json" ] && [ -f "${bin}/plugins.out" ] && { cat "${bin}/plugins.out"; exit 0; }`,
      "  exit 1",
      "fi",
      `printf '%s\\n' "$@" > "${log}/$$"`,
      `for a in "$@"; do case "$a" in reviewer|*:reviewer) cat "${bin}/reviewer.out"; exit 0 ;; esac; done`,
      `cat "${bin}/session.out"`,
      `exit ${opts.sessionExit ?? 0}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  if (opts.route) {
    writeFileSync(join(bin, "route.json"), JSON.stringify(opts.route));
    writeFileSync(join(bin, "npx"), `#!/bin/sh\ncat "${bin}/route.json"\n`, { mode: 0o755 });
  }
  const pluginLog = join(bin, "plugin-list.cwd");
  return {
    bin,
    calls: () => readdirSync(log).map((f) => readFileSync(join(log, f), "utf8")),
    /** The folders `claude plugin list` ran in, one per call. */
    pluginLists: () => (existsSync(pluginLog) ? readFileSync(pluginLog, "utf8").split("\n").filter(Boolean) : []),
  };
}
/** The agent a recorded call ran ("none" for a plain session) and the rules it was allowed to use. */
const agentOf = (call: string) => {
  const lines = call.split("\n");
  return lines.includes("--agent") ? lines[lines.indexOf("--agent") + 1] : "none";
};
const toolsOf = (call: string) => {
  const lines = call.split("\n");
  return lines.slice(lines.indexOf("--allowedTools") + 1).filter(Boolean);
};
const callOf = (calls: string[], agent: string) => {
  const found = calls.filter((c) => agentOf(c) === agent);
  assert.equal(found.length, 1, `one ${agent} call, got ${found.length} of ${calls.map(agentOf)}`);
  return found[0]!;
};
const hasWeb = (call: string) => toolsOf(call).includes("WebSearch") && toolsOf(call).includes("WebFetch");

function runAuto(repo: string, bin: string, env: Record<string, string> = {}) {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES"]) delete clean[k];
  return spawnSync("bash", [autoSh, "write the summary", repo], {
    env: { ...clean, PATH: `${bin}:${process.env.PATH}`, ORCH_MODE: "", ORCH_TEST_CMD: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", ORCH_NO_ESCALATE: "", ORCH_AGENT_PREFIX: "", ...env },
    encoding: "utf8",
  });
}
/** Gives `dir` its own orchestrator and reviewer agent files, as when this project's .claude/ is copied in. */
function withAgents(dir: string) {
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  for (const name of ["orchestrator", "reviewer"]) writeFileSync(join(dir, ".claude", "agents", `${name}.md`), `---\nname: ${name}\ndescription: stub\n---\n`);
  return dir;
}
/** A folder that is not a git repository and has no test runner, with its own orchestrator and reviewer agents. */
function plainFolder() {
  return withAgents(tmp());
}
/** The same, but a git repository with one commit. */
function gitFolder() {
  const dir = plainFolder();
  writeFileSync(join(dir, "README.md"), "base\n");
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]]) {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  return dir;
}
// Stop git looking above the temp folder, so "not a git repository" holds even if the temp root sits inside one.
const notGit = (dir: string) => ({ GIT_CEILING_DIRECTORIES: dirname(dir) });

test("auto.sh reviewed route, task that is not code: web tools for the session and the reviewer, who reads the session's report", () => {
  const repo = plainFolder();
  const t = fakeTools({ session: '{"result":"Wrote notes.md: three findings, each with its source."}' });
  const r = runAuto(repo, t.bin, { ORCH_MODE: "reviewed", ...notGit(repo) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^route: reviewed - .*\(code: no\)$/m);
  assert.match(r.stderr, /^review: pass$/m);
  assert.match(r.stdout, /Wrote notes\.md/, "the session's JSON still goes to stdout");

  const calls = t.calls();
  assert.equal(calls.length, 2);
  const session = callOf(calls, "none");
  const reviewer = callOf(calls, "reviewer");
  assert.ok(hasWeb(session), "the plain session may search and fetch");
  assert.ok(hasWeb(reviewer), "so may the reviewer");
  assert.doesNotMatch(reviewer, /git diff HEAD/);
  assert.doesNotMatch(reviewer, /git status --short/, "this folder is not a git repository");
  assert.match(reviewer, /^The session reported:\nWrote notes\.md: three findings, each with its source\.$/m);
  assert.match(reviewer, /write the summary/, "the reviewer is given the task to check against");
  assert.match(reviewer, /STATUS: pass or STATUS: fail/);
  assert.match(reviewer, /Read the files the session created or changed, as named in the session's report/);
  assert.match(reviewer, /check every requirement of the task, and check each claim against the source it cites/);
  assert.doesNotMatch(reviewer, /run the tests/, "not code: there is nothing to run");
  // Today's read-only rules stay, and nothing that writes.
  assert.match(reviewer, /^Read$/m);
  assert.match(reviewer, /^Bash\(git diff\*\)$/m);
  assert.doesNotMatch(reviewer, WRITES);
});

test("auto.sh reviewed route, code in a git repository: no web tools, the reviewer reads git diff HEAD", () => {
  const repo = gitFolder();
  const t = fakeTools({ session: '{"result":"Edited README.md."}' });
  const r = runAuto(repo, t.bin, { ORCH_MODE: "reviewed" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^route: reviewed - .*\(code: yes\)$/m);

  const calls = t.calls();
  assert.equal(calls.length, 2);
  for (const call of calls) assert.doesNotMatch(call, /WebSearch|WebFetch/, `no web tools in the ${agentOf(call)} call`);
  const reviewer = callOf(calls, "reviewer");
  assert.match(reviewer, /^Review the uncommitted change in this repository against this goal: write the summary$/m);
  assert.match(
    reviewer,
    /Use git diff HEAD, read untracked files from git status --short, and run the tests if you can find them\. Start your reply with STATUS: pass or STATUS: fail\./,
    "the git and code wording is what it always was",
  );
  assert.match(reviewer, /^The session reported:\nEdited README\.md\.$/m, "the report is always included");
  assert.doesNotMatch(reviewer, /check every requirement/, "code: the tests are the check");
  assert.match(reviewer, /^Bash\(git diff\*\)$/m);
  assert.doesNotMatch(reviewer, WRITES);
});

test("auto.sh reviewed route, code outside git: the reviewer gets the report and runs the tests, no git diff, no web tools", () => {
  const repo = plainFolder();
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "tests", "test_a.py"), ""); // a test runner makes it code
  const t = fakeTools({ session: '{"result":"Fixed parse() in app.py and added tests/test_a.py."}' });
  const r = runAuto(repo, t.bin, { ORCH_MODE: "reviewed", ...notGit(repo) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^route: reviewed - .*\(code: yes\)$/m);

  const calls = t.calls();
  assert.equal(calls.length, 2);
  for (const call of calls) assert.doesNotMatch(call, /WebSearch|WebFetch/, `no web tools in the ${agentOf(call)} call`);
  const reviewer = callOf(calls, "reviewer");
  assert.match(reviewer, /^The session reported:\nFixed parse\(\) in app\.py and added tests\/test_a\.py\.$/m);
  assert.match(reviewer, /Read the files the session created or changed, as named in the session's report, and run the tests if you can find them\./);
  assert.match(reviewer, /write the summary/, "the task is the goal");
  assert.match(reviewer, /STATUS: pass or STATUS: fail/);
  assert.doesNotMatch(reviewer, /git diff HEAD/);
  assert.doesNotMatch(reviewer, /git status --short/);
  assert.doesNotMatch(reviewer, /check every requirement/);
  assert.match(reviewer, /^Bash\(python3 -m (pytest|unittest)\*\)$/m, "the runner's rules let it run the tests");
  assert.doesNotMatch(reviewer, WRITES);
});

test("auto.sh: facts.code from the route wins over what the folder looks like", () => {
  const route = (code: boolean) => ({
    mode: "reviewed", source: "triage", reason: "stub", tokens: 0,
    facts: { code, filesToTouch: 1, linesToChange: 10, independentSlices: 1, risky: true, reason: "stub" },
  });
  // A git repository where the task is a report, not code: web tools, and the reviewer reads the report and the git
  // change, then checks requirements and sources instead of running tests.
  const report = gitFolder();
  const a = fakeTools({ session: '{"result":"Report is in docs/report.md."}', route: route(false) });
  const ra = runAuto(report, a.bin);
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stderr, /\(code: no\)/);
  const reviewerA = callOf(a.calls(), "reviewer");
  assert.ok(hasWeb(callOf(a.calls(), "none")) && hasWeb(reviewerA));
  assert.match(reviewerA, /^The session reported:\nReport is in docs\/report\.md\.$/m);
  assert.match(reviewerA, /Use git diff HEAD, read untracked files from git status --short, check every requirement of the task/);
  assert.doesNotMatch(reviewerA, /run the tests/, "not code: nothing to run");

  // A folder that is neither git nor tested, where the triager says the task is code: the tests, but no git diff.
  const folder = plainFolder();
  const b = fakeTools({ session: '{"result":"done"}', route: route(true) });
  const rb = runAuto(folder, b.bin, notGit(folder));
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(rb.stderr, /\(code: yes\)/);
  for (const call of b.calls()) assert.doesNotMatch(call, /WebSearch|WebFetch/);
  const reviewerB = callOf(b.calls(), "reviewer");
  assert.match(reviewerB, /run the tests if you can find them/);
  assert.doesNotMatch(reviewerB, /git diff HEAD/, "not a git work tree, whatever the triager says");
});

test("auto.sh: the user's extra allowed tools are kept, and a web rule they already list is not repeated", () => {
  const repo = tmp();
  const t = fakeTools({ session: '{"result":"ok"}', route: { mode: "plain", source: "forced", reason: "--mode plain", tokens: 0 } });
  const r = runAuto(repo, t.bin, { ORCH_MODE: "plain", ORCH_EXTRA_ALLOWED_TOOLS: "Bash(ruff*)\nWebSearch", ...notGit(repo) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\(code: no\)/, "no facts, no git, no test runner: not code");
  const tools = toolsOf(callOf(t.calls(), "none"));
  assert.ok(tools.includes("Bash(ruff*)"), "the user's rule stays");
  assert.equal(tools.filter((x) => x === "WebSearch").length, 1);
  assert.ok(tools.includes("WebFetch"));
  assert.ok(tools.includes("Edit") && tools.includes("Write"), "the default list is still there");
});

test("auto.sh: a test runner makes a folder code even without git, and gives it no web tools", () => {
  const repo = plainFolder();
  writeFileSync(join(repo, "Cargo.toml"), "");
  const t = fakeTools({ session: '{"result":"ok"}', route: { mode: "plain", source: "forced", reason: "--mode plain", tokens: 0 } });
  const r = runAuto(repo, t.bin, { ORCH_MODE: "plain", ...notGit(repo) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\(code: yes\)/);
  const tools = toolsOf(callOf(t.calls(), "none"));
  assert.ok(tools.includes("Bash(cargo test*)"), "the runner's rules are still added");
  assert.ok(!tools.includes("WebSearch") && !tools.includes("WebFetch"));
});

test("auto.sh reviewed route, task that is not code: the session's report is cut to 4000 characters, an unparsable one is empty", () => {
  const long = fakeTools({ session: JSON.stringify({ result: "Q".repeat(6000) }) });
  const folder = plainFolder();
  const rl = runAuto(folder, long.bin, { ORCH_MODE: "reviewed", ...notGit(folder) });
  assert.equal(rl.status, 0, rl.stderr);
  assert.equal((callOf(long.calls(), "reviewer").match(/Q/g) ?? []).length, 4000);

  const garbled = fakeTools({ session: "plain text, not JSON" });
  const folder2 = plainFolder();
  const rg = runAuto(folder2, garbled.bin, { ORCH_MODE: "reviewed", ...notGit(folder2) });
  assert.equal(rg.status, 0, rg.stderr);
  const reviewer = callOf(garbled.calls(), "reviewer");
  assert.match(reviewer, /^The session reported:$/m);
  assert.doesNotMatch(reviewer, /not JSON/);
});

test("auto.sh escalation: the orchestrator gets web tools for a task that is not code, and the message says where the edits are", () => {
  const route = (code: boolean) => ({
    mode: "plain", source: "triage", reason: "stub", tokens: 0,
    facts: { code, filesToTouch: 1, linesToChange: 10, independentSlices: 1, risky: false, reason: "stub" },
  });
  const failing = { session: '{"result":"boom","is_error":true}', sessionExit: 1 };

  const folder = plainFolder();
  const a = fakeTools({ ...failing, route: route(false) });
  const ra = runAuto(folder, a.bin, notGit(folder));
  assert.notEqual(ra.status, 0);
  assert.match(ra.stderr, /^route: orchestrate \(escalated\) - the plain run failed; its edits stay in place$/m);
  assert.doesNotMatch(ra.stderr, /uncommitted/);
  assert.ok(hasWeb(callOf(a.calls(), "none")) && hasWeb(callOf(a.calls(), "orchestrator")));

  const repo = gitFolder();
  const b = fakeTools({ ...failing, route: route(true) });
  const rb = runAuto(repo, b.bin);
  assert.notEqual(rb.status, 0);
  assert.match(rb.stderr, /^route: orchestrate \(escalated\) - the plain run failed; its edits stay uncommitted, the orchestrator works from HEAD$/m);
  for (const call of b.calls()) assert.doesNotMatch(call, /WebSearch|WebFetch/);
});

/** A reviewed run whose reviewer replies `reply`: auto.sh's exit status and the `review:` verdict it printed. */
function reviewedWith(reply: string) {
  const folder = plainFolder();
  const t = fakeTools({
    session: '{"result":"Wrote notes.md."}',
    reviewer: JSON.stringify({ result: reply }),
    route: { mode: "reviewed", source: "forced", reason: "--mode reviewed", tokens: 0 },
  });
  // A forced mode: a failed review ends the run with its status instead of escalating to the orchestrator.
  const r = runAuto(folder, t.bin, { ORCH_MODE: "reviewed", ...notGit(folder) });
  return { status: r.status, verdict: /^review: (\S+)$/m.exec(r.stderr)?.[1], stderr: r.stderr };
}

test("auto.sh passes a review only on a STATUS: pass line with no STATUS: fail line: a preamble is fine, a quoted report is not a verdict", () => {
  // The reviewer's prompt contains the session's report, which may say STATUS: pass itself.
  const failing = [
    "The session reported: STATUS: pass\nLooks fine.", // no line starts with STATUS: quoting the report is not a verdict
    "The session reported: STATUS: pass\nSTATUS: fail\nGAPS: notes.md cites no source", // the reviewer's own line says fail
    "> STATUS: pass", // a blockquoted line is a quote, never the reviewer's verdict: no verdict at all
    "> STATUS: pass\nSTATUS: fail", // the quote is ignored and the reviewer's own fail counts
    "STATUS: fail\nGAPS: notes.md cites no source\nSTATUS: pass", // the first STATUS line says fail
    "STATUS: pass or fail", // the format template, not a verdict
  ];
  for (const reply of failing) {
    const v = reviewedWith(reply);
    assert.notEqual(v.status, 0, `${JSON.stringify(reply)} must fail the run`);
    assert.equal(v.verdict, "fail", JSON.stringify(reply));
  }
  // A short preamble, emphasis, a heading, indentation and blank lines before the verdict are fine.
  const passing = [
    "Review complete.\n\nSTATUS: pass",
    "**STATUS: pass**\nGAPS: none",
    "\n  ## STATUS: pass\nGAPS: none",
    "> STATUS: fail\nSTATUS: pass", // the quote is ignored and the reviewer's own line counts
    "Earlier I noted STATUS: fail for the draft; the final report fixes it.\n\nSTATUS: pass\nGAPS: none", // mid-line mentions do not count
  ];
  for (const reply of passing) {
    const v = reviewedWith(reply);
    assert.equal(v.status, 0, `${JSON.stringify(reply)} passes: ${v.stderr}`);
    assert.equal(v.verdict, "pass", JSON.stringify(reply));
  }
});

test("auto.sh: an unreadable or empty reviewer reply is a fail", () => {
  for (const raw of ["", "STATUS: pass but not JSON", '{"result":["STATUS: pass"]}']) {
    const folder = plainFolder();
    const t = fakeTools({ session: '{"result":"ok"}', reviewer: raw, route: { mode: "reviewed", source: "forced", reason: "--mode reviewed", tokens: 0 } });
    const r = runAuto(folder, t.bin, { ORCH_MODE: "reviewed", ...notGit(folder) });
    assert.notEqual(r.status, 0, JSON.stringify(raw));
    assert.match(r.stderr, /^review: fail$/m, JSON.stringify(raw));
  }
});

/** orchestrate.sh on `dir` with the fake tools first on PATH. ORCH_DRY_RUN=1 prints the arguments instead of calling claude. */
function runOrchestrate(dir: string, bin: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [orchestrateSh, "t", dir], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCH_AGENT: "", ORCH_AGENT_PREFIX: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", ORCH_TEST_CMD: "", ORCH_DRY_RUN: "", ...env },
    encoding: "utf8",
  });
}

test("orchestrate.sh: the folder's own agent file wins, and the plugin list is not read", () => {
  const t = fakeTools({ session: "{}", plugins: PLUGIN_ON });
  const dir = plainFolder();
  for (const agent of ["orchestrator", "reviewer"]) {
    const r = runOrchestrate(dir, t.bin, { ORCH_DRY_RUN: "1", ORCH_AGENT: agent });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(agentOf(r.stdout), agent);
    assert.doesNotMatch(r.stderr, /^agent:/m);
  }
  assert.deepEqual(t.pluginLists(), []);
});

test("orchestrate.sh: with no agent file of its own, a folder gets the plugin's namespaced agent when the plugin is enabled there", () => {
  const t = fakeTools({ session: '{"result":"ok"}', plugins: PLUGIN_ON });
  const empty = tmp(); // no .claude at all
  const other = tmp(); // agents of its own, but not these
  mkdirSync(join(other, ".claude", "agents"), { recursive: true });
  writeFileSync(join(other, ".claude", "agents", "code-reviewer.md"), "---\nname: code-reviewer\ndescription: stub\n---\n");
  for (const dir of [empty, other]) {
    for (const agent of ["orchestrator", "reviewer"]) {
      const r = runOrchestrate(dir, t.bin, { ORCH_DRY_RUN: "1", ORCH_AGENT: agent });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(agentOf(r.stdout), `orchestration:${agent}`);
      assert.match(r.stderr, new RegExp(`^agent: orchestration:${agent} \\(the orchestration plugin's; no \\.claude/agents/${agent}\\.md in `, "m"));
    }
  }
  assert.equal(t.calls().length, 0, "a dry run calls no model");
  // The check runs in the target folder, whose own settings can disable the plugin.
  assert.deepEqual(t.pluginLists(), [empty, empty, other, other].map((d) => realpathSync(d)));

  const r = runOrchestrate(empty, t.bin);
  assert.equal(r.status, 0, r.stderr);
  const call = callOf(t.calls(), "orchestration:orchestrator");
  assert.ok(toolsOf(call).includes("Agent") && toolsOf(call).includes("SendMessage"), "the default allowlist is unchanged");
});

test("orchestrate.sh: with no agent file and no enabled plugin it exits 1 with the reason, before any model call", () => {
  const list = (id: string, enabled: boolean) => JSON.stringify([{ id, version: "1", scope: "user", enabled }]);
  const answers: (string | null)[] = [
    "[]", // nothing installed
    list("orchestration@claude-code-orchestration", false), // installed, but disabled here (also by this folder's settings)
    list("other@market", true),
    list("orchestration-fork@market", true), // another plugin whose name starts the same
    "error: unknown option '--json'", // not JSON
    '{"id":"orchestration@market","enabled":true}', // not a list
    null, // claude plugin list fails
  ];
  for (const plugins of answers) {
    const t = fakeTools({ session: '{"result":"must not run"}', plugins });
    const r = runOrchestrate(tmp(), t.bin, { ORCH_AGENT: "reviewer" });
    assert.equal(r.status, 1, `${plugins}: ${r.stderr}`);
    assert.match(r.stderr, /^no \.claude\/agents\/reviewer\.md in .*, and the orchestration plugin is not enabled there \(claude plugin list\)\.$/m);
    assert.match(r.stderr, /ORCH_AGENT_PREFIX=orchestration: skips this check\.$/m);
    assert.equal(r.stdout, "");
    assert.equal(t.calls().length, 0, `${plugins}: no model call`);
    assert.equal(t.pluginLists().length, 1);
  }
});

test("orchestrate.sh: ORCH_AGENT_PREFIX and a namespaced ORCH_AGENT skip both checks", () => {
  const t = fakeTools({ session: "{}" }); // no plugin installed: a check would fail
  const own = plainFolder();
  const empty = tmp();
  const agent = (dir: string, env: Record<string, string>) => {
    const r = runOrchestrate(dir, t.bin, { ORCH_DRY_RUN: "1", ...env });
    assert.equal(r.status, 0, r.stderr);
    return agentOf(r.stdout);
  };
  assert.equal(agent(own, { ORCH_AGENT_PREFIX: "orchestration:" }), "orchestration:orchestrator", "the prefix wins over the folder's own agent");
  assert.equal(agent(empty, { ORCH_AGENT_PREFIX: "orchestration" }), "orchestration:orchestrator", "a missing colon is added");
  assert.equal(agent(empty, { ORCH_AGENT_PREFIX: "orchestration:", ORCH_AGENT: "reviewer" }), "orchestration:reviewer");
  assert.equal(agent(empty, { ORCH_AGENT: "orchestration:reviewer" }), "orchestration:reviewer");
  assert.equal(agent(empty, { ORCH_AGENT_PREFIX: "orchestration:", ORCH_AGENT: "orchestration:reviewer" }), "orchestration:reviewer", "never prefixed twice");
  assert.equal(agent(empty, { ORCH_AGENT_PREFIX: "orchestration:", ORCH_AGENT: "none" }), "none");
  assert.deepEqual(t.pluginLists(), []);
});

test("auto.sh reviewed route in a folder with no agents of its own: the plugin's reviewer, with the same tools, prompt and verdict rule", () => {
  const forced = { mode: "reviewed", source: "forced", reason: "--mode reviewed", tokens: 0 };
  const run = (reply: string) => {
    const folder = tmp();
    const t = fakeTools({ session: '{"result":"Wrote notes.md: three findings, each with its source."}', reviewer: JSON.stringify({ result: reply }), plugins: PLUGIN_ON, route: forced });
    return { r: runAuto(folder, t.bin, { ORCH_MODE: "reviewed", ...notGit(folder) }), t, folder };
  };
  const { r, t, folder } = run("Review complete.\n\nSTATUS: pass");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^route: reviewed - .*\(code: no\)$/m);
  assert.match(r.stderr, /^agent: orchestration:reviewer /m);
  assert.match(r.stderr, /^review: pass$/m);
  const calls = t.calls();
  assert.equal(calls.length, 2);
  const reviewer = callOf(calls, "orchestration:reviewer");
  assert.ok(hasWeb(callOf(calls, "none")) && hasWeb(reviewer), "a task that is not code: web tools for the session and the reviewer");
  assert.match(reviewer, /^The session reported:\nWrote notes\.md: three findings, each with its source\.$/m);
  assert.match(reviewer, /Read the files the session created or changed, as named in the session's report, check every requirement of the task/);
  assert.match(reviewer, /^Read$/m);
  assert.match(reviewer, /^Bash\(git diff\*\)$/m);
  assert.doesNotMatch(reviewer, WRITES);
  assert.deepEqual(t.pluginLists(), [realpathSync(folder)], "one check, for the reviewer: the plain session runs no agent");

  for (const reply of ["> STATUS: pass", "> STATUS: pass\nSTATUS: fail", "STATUS: pass\nSTATUS: fail", "Looks fine."]) {
    const v = run(reply).r;
    assert.notEqual(v.status, 0, JSON.stringify(reply));
    assert.match(v.stderr, /^review: fail$/m, JSON.stringify(reply));
  }
});

test("auto.sh escalation in a folder with no agents of its own: the plugin's orchestrator, with web tools for a task that is not code", () => {
  const folder = tmp();
  const t = fakeTools({
    session: '{"result":"boom","is_error":true}',
    sessionExit: 1,
    plugins: PLUGIN_ON,
    route: { mode: "plain", source: "triage", reason: "stub", tokens: 0, facts: { code: false, filesToTouch: 1, linesToChange: 10, independentSlices: 1, risky: false, reason: "stub" } },
  });
  const r = runAuto(folder, t.bin, notGit(folder));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /^route: orchestrate \(escalated\) - the plain run failed; its edits stay in place$/m);
  assert.match(r.stderr, /^agent: orchestration:orchestrator /m);
  const orchestrator = callOf(t.calls(), "orchestration:orchestrator");
  assert.ok(hasWeb(orchestrator));
  assert.ok(toolsOf(orchestrator).includes("Agent") && toolsOf(orchestrator).includes("SendMessage"));
});

test("auto.sh in a folder with no agents and no enabled plugin: the reviewer step stops with the reason, and the review fails", () => {
  const folder = tmp();
  const t = fakeTools({ session: '{"result":"Wrote notes.md."}', route: { mode: "reviewed", source: "forced", reason: "--mode reviewed", tokens: 0 } });
  const r = runAuto(folder, t.bin, { ORCH_MODE: "reviewed", ...notGit(folder) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /^no \.claude\/agents\/reviewer\.md in .*, and the orchestration plugin is not enabled there/m);
  assert.match(r.stderr, /^review: fail$/m);
  assert.deepEqual(t.calls().map(agentOf), ["none"], "only the plain session reached claude");
});

test("detect: config markers alone are not a Python test suite", () => {
  assert.equal(detect({ "pyproject.toml": "[tool.ruff]\n", "setup.cfg": "", "conftest.py": "" }), "");
});

test("detect: a planted pytest.py in the repo is never imported", () => {
  const marker = join(tmp(), "pwned");
  const dir = tmp();
  writeFileSync(join(dir, "pytest.py"), `open(${JSON.stringify(marker)}, "w").write("x")\n`);
  writeFileSync(join(dir, "test_a.py"), "");
  const r = spawnSync("bash", ["-c", `cd "${dir}"; source "${testCmdSh}"; orch_detect_test_cmd "${dir}"`], {
    env: { ...process.env, ORCH_TEST_CMD: "" },
    encoding: "utf8",
  });
  assert.match(r.stdout, /^python3 -m /);
  assert.equal(existsSync(marker), false);
});

test("allow rules: trims, ignores empty, rejects multi-line", () => {
  assert.deepEqual(rules("  custom run  "), ["Bash(custom run*)"]);
  assert.deepEqual(rules(""), []);
  assert.deepEqual(rules("   "), []);
  const r = spawnSync("bash", ["-c", `source "${testCmdSh}"; orch_allow_rules "$1"`, "x", "a\nRead*)"], { encoding: "utf8" });
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /multi-line/);
  assert.deepEqual(rules("a\rb"), []);
});

test("verify.sh: pytest exit 5 (no tests collected) is allowed", () => {
  const r = verify({ ORCH_TEST_CMD: "python3 -m pytest -q; exit 5", ORCH_GATE_ISOLATED: "block" });
  assert.equal(r.status, 0);
  assert.match(r.log, /"reason":"no_tests_collected"/);
});
