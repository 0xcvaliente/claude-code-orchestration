// scripts/orchestrate.sh dry run: --no-session-persistence by default, omitted with ORCH_SESSION_PERSISTENCE=1
// (so headless runs can keep subagent transcripts for telemetry v2's per-agent tokens, turns and models).
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const orchestrateSh = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "orchestrate.sh");

// One folder for every dry run here (the test root removes it): since 1.6.1 the git -C write rules name the repo folder,
// so two runs compare equal only in the same folder.
const dryRepo = mkdtempSync(join(tmpdir(), "orch-sh-"));
/** @param {Record<string, string>} env */
function dryRunArgs(env) {
  const repo = dryRepo;
  {
    const r = spawnSync("bash", [orchestrateSh, "t", repo], {
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ORCH_SESSION_PERSISTENCE: "", ...env },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\n");
  }
}

test("orchestrate.sh dry run: --no-session-persistence by default and for any value but 1", () => {
  for (const v of ["", "0", "yes", "true"]) {
    assert.ok(dryRunArgs({ ORCH_SESSION_PERSISTENCE: v }).includes("--no-session-persistence"), `ORCH_SESSION_PERSISTENCE=${v}`);
  }
});

test("orchestrate.sh dry run: ORCH_SESSION_PERSISTENCE=1 omits --no-session-persistence and keeps the rest", () => {
  const def = dryRunArgs({});
  const kept = dryRunArgs({ ORCH_SESSION_PERSISTENCE: "1" });
  assert.ok(!kept.includes("--no-session-persistence"));
  assert.deepEqual(kept, def.filter((a) => a !== "--no-session-persistence"));
});

test("orchestrate.sh dry run: a plain session (ORCH_AGENT=none) unsets a folder's main agent; a named agent uses --agent", () => {
  // A folder's settings can name a main agent (this repo's .claude/settings.json does). The flag wins over it for a
  // named agent; a plain session passes an empty `agent` in the flag settings, which rank above the folder's.
  const plain = dryRunArgs({ ORCH_AGENT: "none" });
  assert.ok(!plain.includes("--agent"));
  // The same settings JSON asks for the built-in Concise output style (audit O-5); ORCH_OUTPUT_STYLE=default drops it.
  assert.equal(plain[plain.indexOf("--settings") + 1], '{"agent":"","outputStyle":"Concise"}');
  assert.deepEqual(JSON.parse(plain[plain.indexOf("--settings") + 1] ?? "null"), { agent: "", outputStyle: "Concise" });
  const unstyled = dryRunArgs({ ORCH_AGENT: "none", ORCH_OUTPUT_STYLE: "default" });
  assert.equal(unstyled[unstyled.indexOf("--settings") + 1], '{"agent":""}');
  // --disallowedTools and --allowedTools take every word after them: the settings flag must come before both.
  assert.ok(plain.indexOf("--settings") < plain.indexOf("--disallowedTools") && plain.indexOf("--disallowedTools") < plain.indexOf("--allowedTools"));

  const named = dryRunArgs({ ORCH_AGENT: "reviewer", ORCH_AGENT_PREFIX: "orchestration:" });
  assert.equal(named[named.indexOf("--agent") + 1], "orchestration:reviewer");
  assert.ok(!named.includes("--settings"));
});

/** The allow rules: every argument after --allowedTools (variadic, kept last). @param {string[]} args */
const allowed = (args) => args.slice(args.indexOf("--allowedTools") + 1).filter((a) => a !== "");

test("orchestrate.sh dry run: the integrator's last-resort `git reset --merge` is allowed, and only that form of git reset", () => {
  const rules = allowed(dryRunArgs({}));
  assert.ok(rules.includes("Bash(git reset --merge)"), rules.join("\n"));
  const resets = rules.filter((r) => /^Bash\(git\s+(reset|\*)/.test(r));
  assert.deepEqual(resets, ["Bash(git reset --merge)"], "no rule allows the whole git reset family");
});

test("orchestrate.sh dry run: a relative repo path, started from its parent folder, finds the repo's own test runner", () => {
  const parent = mkdtempSync(join(tmpdir(), "orch-sh-rel-"));
  try {
    mkdirSync(join(parent, "proj"));
    writeFileSync(join(parent, "proj", "Cargo.toml"), "[package]\nname = \"p\"\n");
    const r = spawnSync("bash", [orchestrateSh, "t", "proj"], {
      cwd: parent,
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ORCH_SESSION_PERSISTENCE: "" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const rules = allowed(r.stdout.split("\n"));
    assert.ok(rules.includes("Bash(cargo test*)"), rules.join("\n"));
    assert.ok(rules.includes("Bash(cargo build*)"), rules.join("\n"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---- Headless git rules (f3): deny rules for the destructive forms an allow rule's `*` can absorb. ----
// A model of how a permission rule's `*` matches (as in src/scripts-fixes.test.mjs): Bash(<pattern>) matches a command
// when the whole command fits the pattern with every `*` standing for any run of characters, spaces included. Every
// command here is one simple command. The rows are judged against this model, not run.
/** @param {string} rule */
const ruleRe = (rule) => {
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return null;
  return new RegExp(`^${String(m[1]).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s");
};
/** Between --disallowedTools and --allowedTools. @param {string[]} args */
const denied = (args) => args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--allowedTools")).filter((a) => a !== "");
/** @param {string[]} rules @param {string} cmd */
const hits = (rules, cmd) => rules.filter((r) => ruleRe(r)?.test(cmd));
/** @param {string[]} args @param {string} cmd */
const permitted = (args, cmd) => hits(allowed(args), cmd).length > 0 && hits(denied(args), cmd).length === 0;
const headless = () => dryRunArgs({ ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", ORCH_SKILL_CREATE: "off" });
const R = realpathSync(dryRepo);
const WT = `${R}/.claude/worktrees/agent-a1b2`;

// Each row passed the headless rules before f3 (an allowed subcommand word later in the command lets a
// `git -C * <subcommand>*` rule match it) and is denied now: one row per destructive form closed.
const CLOSED = [
  // the two examples of docs/safety.md
  `git -C ${R} branch -D main status`, `git -C ${R} checkout -- . diff`,
  // branch: delete, rename, force
  `git -C ${R} branch -d main status`, `git -C ${R} branch --delete main log`, `git -C ${R} branch --del main log`, `git -C ${R} branch -q -D main status`,
  `git -C ${R} branch main -D status`, `git -C ${R} branch -M x main status`, `git -C ${R} branch -m main old status`, `git -C ${R} branch -q -m main old status`,
  `git -C ${R} branch --move main old status`, `git -C ${R} branch -f main HEAD~3 status`, `git -C ${R} branch --force main HEAD~3 log`,
  // checkout and switch that drop work or move a branch
  `git -C ${R} checkout -f main status`, `git -C ${R} checkout --force main status`, `git -C ${R} checkout . status`, `git -C ${R} checkout HEAD -- src status`,
  `git -C ${R} checkout -B main HEAD~1 status`, `git -C ${R} checkout :/ status`, `git -C ${WT} checkout main -f add x`,
  `git -C ${R} switch -f main status`, `git -C ${R} switch --force main status`, `git -C ${R} switch --discard-changes main status`,
  // restore
  `git -C ${R} restore . status`, `git -C ${R} restore --staged --worktree src diff`, `git -C ${R} restore -W src status`, `git -C ${R} restore :/ status`, `git -C ${R} restore ${R}/src log`,
  // reset beyond `reset --merge` (reset --hard was closed before)
  `git -C ${R} reset --soft HEAD~3 status`, `git -C ${R} reset --mixed HEAD~3 status`, `git -C ${R} reset --keep HEAD~3 status`, `git -C ${R} reset HEAD~3 status`,
  `git -C ${R} reset -q HEAD~3 status`, `git -C ${R} reset @~3 status`, `git -C ${R} reset -- . status`, `git -C ${R} reset main --soft status`,
  // refs and history written directly
  `git -C ${R} update-ref refs/heads/main HEAD~3 status`, `git -C ${R} update-ref -d refs/heads/main log`, `git -C ${R} symbolic-ref HEAD refs/heads/x status`,
  `git -C ${R} gc --prune=now status`, `git -C ${R} gc --aggressive --prune=now log`, `git -C ${R} reflog expire --expire=now --all status`, `git -C ${R} reflog delete HEAD@{1} status`,
  `git -C ${R} worktree remove --force ${WT} status`, `git -C ${R} worktree remove -f ${WT} log`, `git -C ${R} stash drop status`, `git -C ${R} stash clear status`,
  `git -C ${R} rebase -i HEAD~3 log`, `git -C ${R} rebase --onto x y main status`, `git -C ${R} rebase HEAD~3 status`, `git -C ${R} rebase @~3 status`,
  `git -C ${R} filter-branch --index-filter x HEAD status`,
  // a fetch or pull that writes a ref through a refspec destination or --force (audit J-11: in another repository it is a push)
  `git -C ../origin.git fetch -o status "$PWD" main:main`, `git -C ../origin.git fetch "$PWD" main:main status`, `git -C ${R} fetch ../other +refs/heads/*:refs/heads/* log`,
  `git -C ../origin.git fetch --force "$PWD" main status`, `git -C ../origin.git fetch -f "$PWD" main status`, `git -C ../other pull "$PWD" main:main status`,
  `git -C ../other pull --force "$PWD" main status`, `git -C ${WT} fetch ${R} main:main add x`,
];

// Second attempt: the eight under-blocks a review found (clustered or reordered short options, reset --merge with more
// after it, checkout --ours) and the three older ones (rm -rf, tag -d, config), each passing the rules of ed139ef.
const REVIEW_ROWS = [
  `git -C ${R} reset --merge HEAD~3 status`, `git -C ${R} reset -N HEAD~3 status`, `git -C ${R} branch -qD main status`, `git -C ${R} branch -rd origin/main status`,
  `git -C ${R} branch a b -m log`, `git -C ${R} checkout -qf main status`, `git -C ${R} switch -qf main status`, `git -C ${R} checkout --ours . status`,
  `git -C ${R} rm -rf src status`, `git -C ${R} tag -d v1 status`, `git -C ${R} config core.hooksPath /tmp/h status`,
];

// One entry per deny rule of GIT_C_DESTRUCTIVE_DENY (but the two first-word rules, in STILL_DENIED): a form and the
// same form with its options in another order or place. Each is tried in three spellings (shapes() below).
/** @type {[string, string][]} */
const SHAPES = [
  ["branch -qd main", "branch main -d"], ["branch -qD main", "branch main -D"], ["branch -qm main old", "branch main old -m"],
  ["branch -qM main old", "branch main old -M"], ["branch -qf main HEAD~3", "branch main HEAD~3 -f"], ["branch -qC x main", "branch x main --copy --force"],
  ["checkout HEAD -- src", "checkout -q HEAD -- src"], ["checkout -qf main", "checkout main -f"], ["checkout -qB main HEAD~1", "checkout HEAD~1 -B main"],
  ["checkout -qm main", "checkout main --merge"], ["checkout --ours .", "checkout -q --ours src"], ["checkout --theirs .", "checkout -q --theirs src"],
  ["checkout .", "checkout ./src"], ["checkout :/", "checkout :(top)src"],
  ["switch -qf main", "switch main --force"], ["switch -qm main", "switch main --merge"], ["switch -qC main HEAD~3", "switch --quiet -qC main HEAD~3"],
  ["switch --discard-changes main", "switch main --discard-changes"],
  ["restore -qW src", "restore src --staged"], ["restore .", "restore ./src"], ["restore :/", "restore :(top)src"], ["restore /r/src", "restore /r/src /r/doc"],
  ["reset -N HEAD~3", "reset --merge HEAD~3"], ["reset main -q", "reset main --soft"], ["reset HEAD~3", "reset HEAD^ src"], ["reset @~3", "reset @{1}"],
  ["reset ORIG_HEAD", "reset FETCH_HEAD src"],
  ["update-ref refs/heads/main HEAD~3", "update-ref -d refs/heads/main"], ["symbolic-ref HEAD refs/heads/x", "symbolic-ref -q HEAD refs/heads/x"],
  ["gc --prune=now", "gc --aggressive --prune=now"], ["reflog expire --all", "reflog expire --expire=now --all"],
  ["reflog delete HEAD@{1}", "reflog delete --rewrite HEAD@{1}"], ["worktree remove -qf /r/wt", "worktree remove /r/wt --force"],
  ["stash drop", "stash drop -q stash@{1}"], ["stash clear", "stash clear -q"],
  ["rebase -i HEAD~3", "rebase main --onto x"], ["rebase HEAD~3", "rebase HEAD~3 main"], ["rebase @~3", "rebase @{u}"],
  ["filter-branch --index-filter x HEAD", "filter-branch -f HEAD"],
  ['fetch "$PWD" main:main', 'fetch -q "$PWD" +refs/heads/*:refs/heads/*'], ['fetch -qf "$PWD" main', 'fetch "$PWD" main --force'],
  ['pull "$PWD" main:main', 'pull -q "$PWD" main:main'], ['pull -qf "$PWD" main', 'pull "$PWD" main --force'],
  ["rm -rf src", "rm src -r -f"], ["tag -d v1", "tag v1 -d"], ["tag -f v1 HEAD~3", "tag v1 HEAD~3 -f"],
  ["config core.hooksPath /tmp/h", "config set core.hooksPath /tmp/h"], ["config --add core.hooksPath /tmp/h", "config -f .git/config core.x y"],
];
/** Three spellings of each shape: as written with a later allowed word, reordered, and after a quoted `-C` path with a space. */
const shapes = () => SHAPES.flatMap(([a, b]) => [`git -C ${R} ${a} status`, `git -C ${R} ${b} diff`, `git -C "/tmp/a b" ${a} log --oneline`]);

// Limits: forms a rule pattern cannot tell from an everyday word (a path, a revision or a branch name as the argument,
// with no option), so they still pass when an allowed subcommand word follows. scripts/orchestrate.sh names each one.
const LIMITS = [
  `git -C ${R} restore src status`, `git -C ${R} reset main status`, `git -C ${R} reset 0a1b2c3 status`, `git -C ${R} reset origin/main status`,
  `git -C ${R} rebase main status`, `git -C ${R} checkout main src status`, `git -C ${R} rm src status`, `git -C ../other pull "$PWD" main status`,
  `git -C ${R} worktree remove ${WT} status`,
];

// Denied before f3 and still denied: the J-11 commands as written (no allow rule matches them), push and clean.
const STILL_DENIED = [
  'git -C ../origin.git fetch "$PWD" main:main', 'git --git-dir=../origin.git fetch "$PWD" main:main', 'git --work-tree=../x checkout -- .',
  `git -C ${R} --git-dir=../origin.git fetch "$PWD" main:main status`, `git -C ${R} push origin main status`, `git -C ${R} clean -fdx status`,
];

// Everyday commands that stay allowed: a commit message that holds reset, status, restore, checkout, fetch, rebase or
// `a:b` is not caught.
const STILL_ALLOWED = [
  `git -C ${R} status`, `git -C ${R} status --short`, `git -C ${WT} log --oneline -5`, `git -C ${WT} diff HEAD...branch`, `git -C ${R} diff HEAD...worktree-agent-a1b2`,
  `git -C ${WT} add src/a.ts`, `git -C ${WT} add -- src/reset.ts src/branch.ts`, `git -C ${WT} commit -m "fix: reset the status line"`,
  `git -C ${WT} commit -m "fix: reset the status line, map a:b to c:d"`, `git -C ${WT} commit -m "restore defaults, checkout page, fetch data, rebase notes"`,
  `git -C ${R} commit -m "orch: checkpoint wave 1"`, `git -C ${R} merge --no-ff --no-edit worktree-agent-a1b2`, `git -C ${R} merge --abort`, `git -C ${R} reset --merge`,
  `git -C ${R} branch --show-current`, `git -C ${WT} branch --show-current`, `git -C ${R} worktree list`, `git -C ${R} worktree add -b skill/x ${R}/.claude/worktrees/x HEAD`,
  `git -C ${R} log --oneline -5 -- src/branch.ts`, `git -C ${R} show HEAD --stat`, `git -C ${R} diff HEAD -- config.json`, `git -C ${R} rev-parse HEAD`,
  `git -C ${R} ls-files src`, `git -C ${R} rev-list --count HEAD`,
  // second attempt: the worktree's everyday forms, and arguments that hold a colon
  `git -C ${WT} commit -m "fix: x"`, `git -C ${WT} add -A`, `git -C ${WT} diff --stat`, `git -C ${WT} log -5 --format=%s`,
  `git -C ${R} show HEAD:f`, `git -C ${R} diff a:x b:y`, `git -C ${R} log --format=%H:%s`, `git -C ${R} add -- config/x`,
  `git -C ${WT} commit -m "fix config loading, restore defaults, clean up, checkout page, rm dead code"`, `git -C ${R} commit -m "orch: checkpoint config restore"`,
];
// No allow rule names these in a worktree (only the project folder gets reset --merge and merge), before f3 and after;
// they are pinned so that no change here is mistaken for a widening.
const NOT_ALLOWED_IN_WORKTREE = [`git -C ${WT} reset --merge`, `git -C ${WT} merge --abort`];

test("orchestrate.sh dry run (f3): destructive git forms that an allow rule's `*` absorbed are denied", () => {
  const args = headless();
  for (const cmd of CLOSED) assert.equal(permitted(args, cmd), false, `${cmd} is allowed by ${hits(allowed(args), cmd).join(", ")}`);
  for (const cmd of STILL_DENIED) assert.equal(permitted(args, cmd), false, cmd);
});

test("orchestrate.sh dry run (f3): the everyday git commands stay allowed", () => {
  const args = headless();
  for (const cmd of STILL_ALLOWED) {
    assert.ok(permitted(args, cmd), `${cmd}: allow ${hits(allowed(args), cmd).join(", ") || "none"}, deny ${hits(denied(args), cmd).join(", ") || "none"}`);
  }
  for (const cmd of NOT_ALLOWED_IN_WORKTREE) assert.deepEqual(hits(allowed(args), cmd), [], cmd);
});

test("orchestrate.sh dry run (f3, second attempt): the reviewed under-blocks are denied", () => {
  const args = headless();
  for (const cmd of REVIEW_ROWS) assert.equal(permitted(args, cmd), false, `${cmd} is allowed by ${hits(allowed(args), cmd).join(", ")}`);
});

test("orchestrate.sh dry run (f3, second attempt): each deny pattern holds in three spellings (option order, a quoted -C path, a later allowed word)", () => {
  const args = headless();
  for (const cmd of shapes()) {
    assert.ok(hits(allowed(args), cmd).length > 0, `${cmd}: the row must model a form an allow rule absorbs`);
    assert.equal(permitted(args, cmd), false, `${cmd} is allowed by ${hits(allowed(args), cmd).join(", ")}`);
  }
});

test("orchestrate.sh dry run (f3, second attempt): the out-of-reach forms named in orchestrate.sh still pass (limits, not fixed)", () => {
  const args = headless();
  for (const cmd of LIMITS) assert.equal(permitted(args, cmd), true, `limit ${cmd} is now denied: update the "Out of reach" list in orchestrate.sh`);
  const sh = readFileSync(orchestrateSh, "utf8");
  for (const form of ["restore src status", "reset main status", "rebase main status", "checkout main src status", "rm src status", "pull <path> main status", "worktree remove <worktree> status"]) {
    assert.ok(sh.includes(form), `orchestrate.sh names the limit ${form}`);
  }
});

test("orchestrate.sh dry run (f3, second attempt): stated over-blocks of commit messages", () => {
  const args = headless();
  // A commit whose message holds a subcommand word a rule names after a space, followed later by an option word (a
  // second -m, `--`, --no-verify) or by the phrase the rule names, is refused (a word right after the opening quote
  // has no space before it and is not caught). Pinned so that the list in orchestrate.sh stays true.
  for (const cmd of [
    `git -C ${WT} commit -m "fix branch handling" -m "More"`, `git -C ${WT} commit -m "fix: reset cache" -- src/a.ts`, `git -C ${WT} commit -m "update config files. Done"`,
    `git -C ${WT} commit -m "fix checkout page" --no-verify`, `git -C ${WT} commit -m "fix: rm stale file" -- src/a.ts`, `git -C ${WT} commit -m "move tag" -m "details"`,
  ]) assert.equal(permitted(args, cmd), false, cmd);
});

test("orchestrate.sh dry run (f3): stated over-blocks and limits, pinned so a change to them is seen", () => {
  const args = headless();
  // Over-blocks: a deny rule cannot tell a commit message from a subcommand. The push one predates f3 (a deny that
  // goes away would widen the rules); the others need the phrase a rule names.
  for (const cmd of [
    `git -C ${WT} commit -m "fix: push the button"`, `git -C ${WT} commit -m "fix fetch of a:b pairs"`, `git -C ${WT} commit -m "fix: reset HEAD handling"`,
    `git -C ${WT} commit -m "drop the branch -D shortcut"`,
  ]) assert.equal(permitted(args, cmd), false, cmd);
  // Limits: a destructive form a rule pattern cannot tell from an everyday word still passes when an allowed
  // subcommand word follows (a path or a branch name as the argument).
  for (const cmd of [`git -C ${R} restore src status`, `git -C ${R} reset main status`, `git -C ${R} rebase main status`, `git -C ${R} checkout main src status`]) {
    assert.equal(permitted(args, cmd), true, cmd);
  }
});

test("orchestrate.sh dry run (f3): no deny rule ends in `:*`, which Claude Code reads as its older prefix form", () => {
  for (const rule of denied(headless())) assert.ok(!rule.endsWith(":*)"), rule);
});

test("orchestrate.sh: a repo folder that does not exist is still an error", () => {
  const parent = mkdtempSync(join(tmpdir(), "orch-sh-rel-"));
  try {
    const r = spawnSync("bash", [orchestrateSh, "t", "missing"], {
      cwd: parent,
      env: { ...process.env, ORCH_DRY_RUN: "1", ORCH_AGENT: "none", ORCH_TEST_CMD: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "" },
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
