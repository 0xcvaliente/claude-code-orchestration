import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  assert.match(detect({ "pyproject.toml": "" }), /^python3 -m (pytest -q|unittest discover -q)$/);
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
  const run = (env: Record<string, string>) =>
    spawnSync("bash", [orchestrateSh, "t", repo], {
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ...env },
      encoding: "utf8",
    });
  const base = run({});
  assert.equal(base.status, 0);
  assert.match(base.stdout, /Bash\(python3 -m (pytest|unittest)\*\)/);
  assert.doesNotMatch(base.stdout, /--model/);
  const full = run({ ORCH_MODEL: "sonnet", ORCH_EXTRA_ALLOWED_TOOLS: "Bash(ruff*)\n\nBash(mypy*)" });
  const lines = full.stdout.split("\n");
  assert.equal(lines[lines.indexOf("--model") + 1], "sonnet");
  assert.ok(lines.includes("Bash(ruff*)") && lines.includes("Bash(mypy*)"));
  assert.ok(lines.indexOf("--allowedTools") > lines.indexOf("--model"), "--allowedTools stays last");
});
