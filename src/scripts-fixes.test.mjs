// Regression tests for the launcher and script fixes of the 2026-11-16 audit (docs/data/audit-2026-11-16/):
// W-3 the headless git rules, W-4 a dash-led task, W-5 CDPATH, O-9 the terminal form of the result, O-5 the plain
// sessions' output style. The launchers run with ORCH_DRY_RUN=1 or a fake `claude` first on PATH: no model call.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
