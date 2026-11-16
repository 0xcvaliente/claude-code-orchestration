// Regression tests for the launcher and script fixes of the 2026-11-16 audit (docs/data/audit-2026-11-16/):
// W-3 the headless git rules, W-4 a dash-led task, W-5 CDPATH, O-9 the terminal form of the result, O-5 the plain
// sessions' output style. The launchers run with ORCH_DRY_RUN=1 or a fake `claude` first on PATH: no model call.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const orchestrateSh = join(root, "scripts", "orchestrate.sh");

const BASE_ENV = { ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ORCH_SESSION_PERSISTENCE: "", ORCH_SKILL_CREATE: "off", ORCH_OUTPUT_STYLE: undefined };

/** orchestrate.sh's claude arguments, one per element. @param {Record<string, string | undefined>} env @param {string} [task] */
function dryRun(env = {}, task = "t") {
  const repo = mkdtempSync(join(tmpdir(), "orch-fix-"));
  try {
    /** @type {Record<string, string>} */
    const merged = {};
    for (const [k, v] of Object.entries({ ...process.env, ...BASE_ENV, ...env })) if (v !== undefined) merged[k] = v;
    const r = spawnSync("bash", [orchestrateSh, task, repo], { env: merged, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.replace(/\n$/, "").split("\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** Between --disallowedTools and --allowedTools. @param {string[]} args */
const denyRules = (args) => args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--allowedTools"));
/** After --allowedTools, up to the `--` that ends the options. @param {string[]} args */
const allowRules = (args) => {
  const from = args.indexOf("--allowedTools") + 1;
  const end = args.indexOf("--", from);
  return args.slice(from, end < 0 ? undefined : end).filter(Boolean);
};

// A model of how a permission rule's `*` matches: Bash(<pattern>) matches a command when the whole command fits the
// pattern with every `*` standing for any run of characters (spaces included). Claude Code splits compound commands
// before it matches; every command here is one simple command.
/** @param {string} rule */
const ruleRe = (rule) => {
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return null;
  return new RegExp(`^${String(m[1]).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s");
};
/** @param {string[]} rules @param {string} cmd */
const matches = (rules, cmd) => rules.filter((r) => ruleRe(r)?.test(cmd));
/** @param {string[]} args @param {string} cmd */
const permitted = (args, cmd) => matches(allowRules(args), cmd).length > 0 && matches(denyRules(args), cmd).length === 0;

// The rules every headless run had before this fix (orchestrate.sh 1.4.5), for the "nothing widens" checks.
const OLD_ALLOW_GIT = ["Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)", "Bash(git rev-parse*)", "Bash(git add*)", "Bash(git commit*)", "Bash(git merge*)", "Bash(git branch*)", "Bash(git worktree*)", "Bash(git reset --merge)", "Bash(git -C *)"];
const OLD_DENY = ["Bash(git push*)", "Bash(git * push*)", "Bash(git remote*)", "Bash(git * remote*)", "Bash(sudo*)", "Bash(rm -rf*)", "Bash(rm -fr*)", "Bash(rm -r -f*)", "Bash(rm -f -r*)"];

const R = "/work/repo";
const WT = `${R}/.claude/worktrees/agent-a1b2`;

test("W-3: the five git forms the old `Bash(git -C *)` reached are not allowed in a headless run", () => {
  const args = dryRun();
  const five = [`git -C ${R} reset --hard`, `git -C ${R} clean -fdx`, `git -C ${R} checkout -- .`, `git -C ${R} -c core.hooksPath=/x commit -m m`, `git -C ${R} -c alias.p=push p origin main`];
  for (const cmd of five) {
    assert.equal(permitted(args, cmd), false, `${cmd} is allowed by ${matches(allowRules(args), cmd).join(", ")}`);
  }
});

test("W-3: other spellings of reset --hard, clean, -c and --config-env, and git forms a wildcard path can reach, are refused", () => {
  const args = dryRun();
  const refused = [
    "git reset --hard", "git reset --hard HEAD~1", "git reset -q --hard", "git reset --har", `git -C ${R} reset -q --hard`, `git -C ${R} reset --ha HEAD`, `git -C${R} reset --hard`,
    "git clean -fdx", "git clean -n", `git -C ${WT} clean -f`, `git -C ${R} clean -fdx status`,
    "git -c core.hooksPath=/x commit -m m", "git -c alias.p=push p origin main", `git -C ${R} -c user.name=x commit -m m`, `git -C ${WT} -c core.hooksPath=/x add -A`,
    "git --config-env=core.hooksPath=X commit -m m", `git -C ${R} --config-env core.hooksPath=X commit -m m`,
    `git -C ${R} checkout -- . diff`, `git -C ${R} restore --ignore-unmatch . status`, "git checkout -- .", "git restore .",
    `git -C ${R} config core.hooksPath /x status`, "git config core.hooksPath /x", `git -C ${R} rm -rf --ignore-unmatch . log`,
  ];
  for (const cmd of refused) assert.equal(permitted(args, cmd), false, `${cmd} is allowed by ${matches(allowRules(args), cmd).join(", ")}`);
});

test("W-3: every git form the agents use in a headless run is still allowed", () => {
  const args = dryRun();
  const needed = [
    // integrator: merge, abort, the merge-in-progress check, status, the last-resort reset, checkpoint add and commit
    "git merge --no-ff --no-edit worktree-agent-a1b2", "git merge --abort", "git rev-parse -q --verify MERGE_HEAD", "git status", "git status --short", "git reset --merge",
    "git add -- src/a.ts docs/b.md", 'git commit -m "orch: checkpoint wave 1"', "git branch --show-current",
    `git -C ${R} merge --no-ff --no-edit worktree-agent-a1b2`, `git -C ${R} merge --abort`, `git -C ${R} rev-parse -q --verify MERGE_HEAD`, `git -C ${R} reset --merge`,
    `git -C ${R} add -- src/a.ts`, `git -C ${R} commit -m "orch: checkpoint wave 1"`,
    // isolated implementer, in its worktree or through git -C
    "git add -A", 'git commit -m "fix-scripts"', "git diff", "git diff HEAD", `git -C ${WT} add -A`, `git -C ${WT} commit -m "s1"`, `git -C ${WT} status --short`, `git -C ${WT} diff`, `git -C ${WT} branch --show-current`,
    // reviewer
    `git -C ${R} diff HEAD...worktree-agent-a1b2`, `git -C ${R} log --oneline -5`, `git -C ${R} show HEAD --stat`, `git -C ${R} status --short`, "git worktree list", `git -C ${R} worktree list`, "git log --oneline -3", "git show HEAD",
    // researcher's read-only list
    `git -C ${R} ls-files src`, `git -C ${R} rev-list --count HEAD`, `git -C ${R} rev-parse HEAD`, `git -C ${R} branch --show-current`,
    // a skill slice: the draft worktree from its brief, then add, commit, status and branch there
    "git -C /s/skills worktree add -b skill/demo /h/.claude/orchestration/skill-drafts/private/demo main", "git -C /h/.claude/orchestration/skill-drafts/private/demo add -A",
    'git -C /h/.claude/orchestration/skill-drafts/private/demo commit -m "skill: demo"',
  ];
  for (const cmd of needed) assert.ok(permitted(args, cmd), `${cmd}: allow ${matches(allowRules(args), cmd).join(", ") || "none"}, deny ${matches(denyRules(args), cmd).join(", ") || "none"}`);
});

test("W-3: every rule denied before is still denied, and no git allow rule reaches beyond the old ones", () => {
  const args = dryRun();
  const deny = denyRules(args);
  for (const rule of OLD_DENY) assert.ok(deny.includes(rule), `${rule} is no longer denied`);
  const gitAllow = allowRules(args).filter((r) => r.startsWith("Bash(git"));
  assert.ok(!gitAllow.includes("Bash(git -C *)"), "the open git -C rule is gone");
  for (const rule of gitAllow) {
    assert.ok(OLD_ALLOW_GIT.includes(rule) || rule.startsWith("Bash(git -C * "), `${rule} is not one of the old rules or a git -C form of one`);
  }
  // Each sample still refused, whatever the allow list says.
  for (const cmd of ["git push origin main", `git -C ${R} push`, "git remote add o u", `git -C ${R} remote -v`, "sudo ls", "rm -rf /", "rm -fr x", "rm -r -f x", "rm -f -r x"]) {
    assert.equal(permitted(args, cmd), false, cmd);
  }
});

test("W-3: the git denies are on every headless run, also with a replaced allow list", () => {
  const def = denyRules(dryRun());
  const replaced = denyRules(dryRun({ ORCH_ALLOWED_TOOLS: "Read\nBash(git -C *)" }));
  assert.deepEqual(replaced, def);
  assert.equal(permitted(dryRun({ ORCH_ALLOWED_TOOLS: "Read\nBash(git -C *)" }), `git -C ${R} reset --hard`), false);
});

test("W-4: a task that starts with a dash goes after `--` at the end, never as the word after -p", () => {
  for (const task of ["-x leading dash task", "--help", "-"]) {
    const args = dryRun({}, task);
    assert.deepEqual(args.slice(-2), ["--", task], args.join(" | "));
    assert.equal(args[0], "-p");
    assert.notEqual(args[1], task, "the task is not the word after -p");
    assert.equal(args.filter((a) => a === task).length, 1);
    assert.ok(args.indexOf("--") > args.indexOf("--allowedTools"), "`--` also ends the variadic --allowedTools");
  }
  // Any other task keeps its place after -p, so the arguments of an ordinary run do not change.
  const plain = dryRun({}, "fix the bug");
  assert.deepEqual(plain.slice(0, 2), ["-p", "fix the bug"]);
  assert.ok(!plain.includes("--"));
});

/**
 * A fake `claude` and `npx` in `<dir>/bin`: claude records its folder and arguments and prints `out`; npx records its
 * arguments and prints a forced plain route. @param {string} dir @param {string} [out]
 */
function fakeBin(dir, out = '{"type":"result","is_error":false,"result":"ok","num_turns":1}') {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude.out"), `${out}\n`);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\npwd -P > "${bin}/claude.cwd"\nprintf '%s\\n' "$@" > "${bin}/claude.args"\ncat "${bin}/claude.out"\n`);
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/npx.args"\nprintf '%s' '{"mode":"plain","source":"forced","reason":"--mode plain","tokens":0}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "npx"), 0o755);
  return bin;
}
/** process.env without undefined values, plus `env`. @param {Record<string, string | undefined>} env */
function cleanEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries({ ...process.env, ...BASE_ENV, ORCH_DRY_RUN: "", ORCH_MODE: "", ORCH_NO_ESCALATE: "1", ORCH_AGENT_PREFIX: "", ORCH_MODEL: "", ...env })) if (v !== undefined) out[k] = v;
  return out;
}

test("W-5: auto.sh resolves a relative repo against the caller's folder, not through an exported CDPATH", () => {
  const tmp = mkdtempSync(join(tmpdir(), "orch-fix-cdpath-"));
  try {
    const work = join(tmp, "work");
    const cdp = join(tmp, "cdp");
    for (const d of [join(work, "proj", ".claude", "agents"), join(cdp, "proj")]) mkdirSync(d, { recursive: true });
    const bin = fakeBin(tmp);
    const r = spawnSync("bash", [join(root, "scripts", "auto.sh"), "task", "proj"], { cwd: work, env: cleanEnv({ PATH: `${bin}:${process.env.PATH}`, CDPATH: cdp, ORCH_MODE: "plain", GIT_CEILING_DIRECTORIES: tmp }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const npxArgs = readFileSync(join(bin, "npx.args"), "utf8").split("\n");
    const repoArg = npxArgs[npxArgs.indexOf("--repo") + 1];
    assert.equal(realpathSync(String(repoArg)), realpathSync(join(work, "proj")), `route.ts got ${JSON.stringify(repoArg)}`);
    assert.equal(readFileSync(join(bin, "claude.cwd"), "utf8").trim(), realpathSync(join(work, "proj")), "the session runs in ./proj");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

for (const script of ["auto.sh", "orchestrate.sh"]) {
  test(`W-5: scripts/${script} started by a relative path finds its own folder whatever CDPATH says`, () => {
    const tmp = mkdtempSync(join(tmpdir(), "orch-fix-here-"));
    try {
      // A CDPATH folder with a scripts/ of its own: an unguarded `cd scripts` goes there and prints its path.
      mkdirSync(join(tmp, "cdp", "scripts"), { recursive: true });
      const repo = join(tmp, "repo");
      mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
      const bin = fakeBin(tmp);
      const env = cleanEnv({ PATH: `${bin}:${process.env.PATH}`, CDPATH: join(tmp, "cdp"), ORCH_MODE: "plain", ORCH_TEST_CMD: "pytest", GIT_CEILING_DIRECTORIES: tmp });
      const r = spawnSync("bash", [join("scripts", script), "task", repo], { cwd: root, env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr.replace(/^route: .*\n/m, ""), "", "no error from a wrong folder");
      const args = readFileSync(join(bin, "claude.args"), "utf8").split("\n");
      assert.ok(allowRules(args).includes("Bash(pytest*)"), "the runner rules come from the launcher's own folder");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

const RESULT_DOC = JSON.stringify({ type: "result", is_error: false, result: "Done.\nTwo files changed.", num_turns: 3, orch_totals: { results: 2, turns: 41, wall_ms: 723400, exit_code: 0, complete: true } });
// What the fake claude prints: one result record of 41 turns (orchestrate.sh adds orch_totals itself).
const STREAM_DOC = JSON.stringify({ type: "result", is_error: false, result: "Done.\nTwo files changed.", num_turns: 41 });

test("O-9: the terminal form is the result text and one totals line; anything that is not a result document is unchanged", async () => {
  const { terminalForm } = await import("../scripts/run-result.mjs");
  assert.equal(terminalForm(RESULT_DOC), "Done.\nTwo files changed.\nturns 41, 723 s, exit 0");
  // older documents without orch_totals: their own num_turns and duration_ms; unknown values print as ?
  assert.equal(terminalForm(JSON.stringify({ type: "result", result: "ok", num_turns: 2, duration_ms: 1500 })), "ok\nturns 2, 2 s, exit ?");
  assert.equal(terminalForm(JSON.stringify({ type: "result", subtype: "no_result", is_error: true, result: "", orch_totals: { results: 0, turns: 0, wall_ms: null, exit_code: 1, complete: false } })), "turns 0, ? s, exit 1");
  for (const raw of ["error: not logged in", "", "[1,2]", '{"a":1}', "null"]) assert.equal(terminalForm(raw), raw);
});

/** Runs `argv` with its standard output on a pseudo-terminal (script(1)); null when this system has no usable script. @param {string[]} argv @param {Record<string, string>} env */
function onTerminal(argv, env) {
  const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  // stdin closed: script(1) cannot set up a terminal on a pipe, and with no input it only echoes the end of input.
  /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */
  const opts = { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const r = process.platform === "darwin" ? spawnSync("script", ["-q", "/dev/null", ...argv], opts) : spawnSync("script", ["-qec", quoted, "/dev/null"], opts);
  if (r.error || (r.status !== 0 && /usage|illegal option|invalid option|tcgetattr|ioctl/i.test(r.stderr))) return null;
  return { status: r.status, stderr: r.stderr, stdout: r.stdout.replace(/\^D\x08\x08/g, "").replace(/\r/g, "") };
}

test("O-9: orchestrate.sh prints the terminal form on a terminal and the JSON document when piped", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "orch-fix-tty-"));
  try {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const bin = fakeBin(tmp, STREAM_DOC);
    const env = cleanEnv({ PATH: `${bin}:${process.env.PATH}` });
    const piped = spawnSync("bash", [orchestrateSh, "task", repo], { env, encoding: "utf8" });
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(JSON.parse(piped.stdout).orch_totals.turns, 41, "piped: one JSON document, as auto.sh and the bench read it");
    const log = readFileSync(join(repo, ".claude", "state", "runs.jsonl"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(String(log.at(-1))).turns, 41);
    const tty = onTerminal(["bash", orchestrateSh, "task", repo], env);
    if (!tty) return t.skip("no script(1) to give the launcher a terminal");
    assert.equal(tty.status, 0, tty.stderr);
    const out = tty.stdout;
    assert.match(out, /^Done\.\nTwo files changed\.\nturns 41, \d+ s, exit 0\n$/, out);
    const log2 = readFileSync(join(repo, ".claude", "state", "runs.jsonl"), "utf8").trim().split("\n");
    assert.equal(log2.length, 2, "the run is logged on a terminal too");
    assert.equal(JSON.parse(String(log2.at(-1))).turns, 41, "the log still reads the document");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("O-9: auto.sh prints the plain session's terminal form on a terminal and its JSON when piped", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "orch-fix-tty-auto-"));
  try {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
    const bin = fakeBin(tmp, STREAM_DOC);
    const env = cleanEnv({ PATH: `${bin}:${process.env.PATH}`, ORCH_MODE: "plain", GIT_CEILING_DIRECTORIES: tmp });
    const piped = spawnSync("bash", [join(root, "scripts", "auto.sh"), "task", repo], { env, encoding: "utf8" });
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(JSON.parse(piped.stdout).result, "Done.\nTwo files changed.");
    const tty = onTerminal(["bash", join(root, "scripts", "auto.sh"), "task", repo], env);
    if (!tty) return t.skip("no script(1) to give the launcher a terminal");
    assert.equal(tty.status, 0, tty.stderr);
    assert.match(tty.stdout, /(^|\n)Done\.\nTwo files changed\.\nturns 41, \d+ s, exit 0\n$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

for (const launcher of ["native-launch.sh", "plugin-launch.sh"]) {
  test(`W-4: bench/lib/${launcher} carries a dash-led prompt through as the positional prompt after --`, () => {
    const tmp = mkdtempSync(join(tmpdir(), "orch-fix-launch-"));
    try {
      const repo = join(tmp, "repo");
      const plugin = join(tmp, "plugin");
      mkdirSync(repo);
      mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
      writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}");
      /** @type {Record<string, string>} */
      const env = {};
      for (const [k, v] of Object.entries({ ...process.env, ...BASE_ENV, ORCH_DRY_RUN: "", ORCH_AGENT_PREFIX: "orchestration:", BENCH_LAUNCH_DRY_RUN: "1" })) if (v !== undefined) env[k] = v;
      for (const prompt of ["-x dash prompt\nsecond line", "plain prompt"]) {
        const extra = launcher === "plugin-launch.sh" ? [plugin] : [];
        const r = spawnSync("bash", [join(root, "bench", "lib", launcher), root, prompt, repo, ...extra], { env, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        const out = r.stdout;
        if (prompt.startsWith("-")) {
          assert.ok(out.endsWith(`\n--\n${prompt}\n`), out);
          assert.ok(!out.includes("__BENCH_PROMPT_PLACEHOLDER__"), out);
        } else {
          assert.match(out, /(^|\n)-p\nplain prompt\n/);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
