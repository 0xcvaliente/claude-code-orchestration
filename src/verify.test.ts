import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("auto.sh reviewed route: the reviewer gets the detected runner's rules and no broader Bash", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
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

/**
 * A bin dir for PATH with a fake `claude` and, when `route` is given, a fake `npx` that answers auto.sh's route step with
 * that decision instead of calling a model. The fake claude records each call's arguments (one file per call), answers a
 * reviewer call with `reviewer` (default: STATUS: pass) and any other call with the contents of session.out.
 */
function fakeTools(opts: { session: string; sessionExit?: number; route?: object; reviewer?: string }) {
  const bin = tmp();
  const log = join(bin, "calls");
  mkdirSync(log);
  writeFileSync(join(bin, "session.out"), opts.session);
  writeFileSync(join(bin, "reviewer.out"), opts.reviewer ?? '{"result":"STATUS: pass"}');
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${log}/$$"`,
      `for a in "$@"; do [ "$a" = reviewer ] && { cat "${bin}/reviewer.out"; exit 0; }; done`,
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
  return { bin, calls: () => readdirSync(log).map((f) => readFileSync(join(log, f), "utf8")) };
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
    env: { ...clean, PATH: `${bin}:${process.env.PATH}`, ORCH_MODE: "", ORCH_TEST_CMD: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", ORCH_NO_ESCALATE: "", ...env },
    encoding: "utf8",
  });
}
/** A folder that is not a git repository and has no test runner, with the agents the reviewer needs. */
function plainFolder() {
  const dir = tmp();
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  return dir;
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
    mode: "reviewed", source: "triage", reason: "stub", costUsd: 0,
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
  const t = fakeTools({ session: '{"result":"ok"}', route: { mode: "plain", source: "forced", reason: "--mode plain", costUsd: 0 } });
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
  const t = fakeTools({ session: '{"result":"ok"}', route: { mode: "plain", source: "forced", reason: "--mode plain", costUsd: 0 } });
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
    mode: "plain", source: "triage", reason: "stub", costUsd: 0,
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
    route: { mode: "reviewed", source: "forced", reason: "--mode reviewed", costUsd: 0 },
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
    "> STATUS: pass\nSTATUS: fail", // a quoted pass line, then the reviewer's own fail: any fail line fails the review
    "STATUS: fail\nGAPS: notes.md cites no source\nSTATUS: pass", // the first STATUS line says fail
    "STATUS: pass or fail", // the format template, not a verdict
  ];
  for (const reply of failing) {
    const v = reviewedWith(reply);
    assert.notEqual(v.status, 0, `${JSON.stringify(reply)} must fail the run`);
    assert.equal(v.verdict, "fail", JSON.stringify(reply));
  }
  // A short preamble, emphasis, a quote, indentation and blank lines before the verdict are fine.
  const passing = [
    "Review complete.\n\nSTATUS: pass",
    "**STATUS: pass**\nGAPS: none",
    "\n  > STATUS: pass\nGAPS: none",
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
    const t = fakeTools({ session: '{"result":"ok"}', reviewer: raw, route: { mode: "reviewed", source: "forced", reason: "--mode reviewed", costUsd: 0 } });
    const r = runAuto(folder, t.bin, { ORCH_MODE: "reviewed", ...notGit(folder) });
    assert.notEqual(r.status, 0, JSON.stringify(raw));
    assert.match(r.stderr, /^review: fail$/m, JSON.stringify(raw));
  }
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
