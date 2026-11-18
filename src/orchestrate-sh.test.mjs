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

// The base: the deny list of release-2.0.0 (b0f1388), stored here so that no test reads git history. f3 changes no
// allow rule, so a command's base decision is the script's own allow list with this deny list.
const BASE_DENY = [
  "Bash(git push*)", "Bash(git * push*)", "Bash(git remote*)", "Bash(git * remote*)",
  "Bash(sudo*)", "Bash(rm -rf*)", "Bash(rm -fr*)", "Bash(rm -r -f*)", "Bash(rm -f -r*)",
  "Bash(git -c*)", "Bash(git * -c*)", "Bash(git --config-env*)", "Bash(git * --config-env*)",
  "Bash(git reset *--h*)", "Bash(git * reset *--h*)", "Bash(git clean*)", "Bash(git * clean -*)",
  "Bash(git * --namespace*)", "Bash(git * --git-dir*)", "Bash(git * --work-tree*)", "Bash(git * --exec-path*)",
  "Bash(git * --super-prefix*)", "Bash(git * --attr-source*)", "Bash(git * -C *)", "Bash(git -C */../*)",
];
/** @param {string[]} args @param {string} cmd */
const basePermitted = (args, cmd) => hits(allowed(args), cmd).length > 0 && hits(BASE_DENY, cmd).length === 0;
/** GIT_C_DESTRUCTIVE_DENY: every deny rule after the base list. @param {string[]} args */
const newRules = (args) => denied(args).slice(BASE_DENY.length);

// One entry per rule of GIT_C_DESTRUCTIVE_DENY (but the two first-word rules, FIRST_WORD below), in the script's order:
// the subcommand word, one space, its literal token. Each form is tried in the spellings of SPELL (at least three rows
// per rule), and every row must pass the base rules (so it fails before f3) and hit its own rule.
/** @type {[string, string[]][]} */
const RULE_FORMS = [
  ["Bash(git -C * branch -d*)", ["branch -d main", "branch -dr origin/main"]],
  ["Bash(git -C * branch -D*)", ["branch -D main", "branch -Dq x"]],
  ["Bash(git -C * branch -m*)", ["branch -m main old", "branch -mq main old"]],
  ["Bash(git -C * branch -M*)", ["branch -M x main", "branch -M main"]],
  ["Bash(git -C * branch -f*)", ["branch -f main HEAD~3", "branch -fq main HEAD~3"]],
  // a plain `-C ` is refused by the base rule `git * -C *` already; `-C` with a letter after it is not
  ["Bash(git -C * branch -C*)", ["branch -Cq x main"]],
  ["Bash(git -C * branch --delete*)", ["branch --delete main"]],
  ["Bash(git -C * branch --move*)", ["branch --move main old"]],
  ["Bash(git -C * branch --force*)", ["branch --force main HEAD~3"]],
  ["Bash(git -C * branch --copy*)", ["branch --copy x main"]],
  ["Bash(git -C * checkout --*)", ["checkout -- .", "checkout --force main", "checkout --ours ."]],
  ["Bash(git -C * checkout -f*)", ["checkout -f main", "checkout -fq main"]],
  ["Bash(git -C * checkout -B*)", ["checkout -B main HEAD~1"]],
  ["Bash(git -C * checkout .)", []], ["Bash(git -C * checkout . *)", ["checkout .", "checkout . src"]],
  ["Bash(git -C * checkout :/)", []], ["Bash(git -C * checkout :/ *)", ["checkout :/", "checkout :/ src"]],
  ["Bash(git -C * switch -f*)", ["switch -f main"]],
  ["Bash(git -C * switch --force*)", ["switch --force main"]],
  ["Bash(git -C * switch --discard-changes*)", ["switch --discard-changes main"]],
  ["Bash(git -C * switch -C*)", ["switch -Cmain HEAD~3"]],
  ["Bash(git -C * restore -*)", ["restore --staged x", "restore -W src", "restore --source=HEAD~3 src"]],
  ["Bash(git -C * restore .)", []], ["Bash(git -C * restore . *)", ["restore .", "restore . src"]],
  ["Bash(git -C * restore :/)", []], ["Bash(git -C * restore :/ *)", ["restore :/", "restore :/ src"]],
  ["Bash(git -C * reset --soft*)", ["reset --soft HEAD~3"]],
  ["Bash(git -C * reset --mixed*)", ["reset --mixed HEAD~3"]],
  ["Bash(git -C * reset --keep*)", ["reset --keep HEAD~3"]],
  ["Bash(git -C * reset -N*)", ["reset -N HEAD~3"]],
  ["Bash(git -C * reset -p*)", ["reset -p HEAD~3"]],
  ["Bash(git -C * reset --patch*)", ["reset --patch HEAD~3"]],
  ["Bash(git -C * rebase -*)", ["rebase -i HEAD~3", "rebase --onto x y main", "rebase -q main"]],
  ["Bash(git -C * fetch --force*)", ['fetch --force "$PWD" main']],
  ["Bash(git -C * fetch -f*)", ['fetch -f "$PWD" main:main']],
  ["Bash(git -C * pull --force*)", ['pull --force "$PWD" main']],
  ["Bash(git -C * pull -f*)", ['pull -f "$PWD" main']],
  ["Bash(git -C * pull --rebase*)", ['pull --rebase "$PWD" main']],
  ["Bash(git -C * rm -*)", ["rm -rf src", "rm -r src", "rm --cached src"]],
  ["Bash(git -C * tag -d*)", ["tag -d v1"]],
  ["Bash(git -C * tag --delete*)", ["tag --delete v1"]],
  ["Bash(git -C * tag -f*)", ["tag -f v1 HEAD~3"]],
  ["Bash(git -C * worktree remove -*)", ["worktree remove --force /r/wt", "worktree remove -f /r/wt"]],
  ["Bash(git -C * stash drop)", []], ["Bash(git -C * stash drop *)", ["stash drop", "stash drop -q stash@{1}"]],
  ["Bash(git -C * stash clear)", []], ["Bash(git -C * stash clear *)", ["stash clear", "stash clear -q"]],
  ["Bash(git -C * gc --prune*)", ["gc --prune=now", "gc --prune=all", "gc --prune"]],
  ["Bash(git -C * reflog expire)", []], ["Bash(git -C * reflog expire *)", ["reflog expire --expire=now --all", "reflog expire --all"]],
  ["Bash(git -C * reflog delete)", []], ["Bash(git -C * reflog delete *)", ["reflog delete HEAD@{1}", "reflog delete --rewrite HEAD@{1}"]],
  ["Bash(git -C * config -*)", ["config --add core.x y", "config -f .git/config core.x y", "config --unset core.x"]],
  ["Bash(git -C * config core.*)", ["config core.hooksPath /tmp/h", "config core.sshCommand x", "config core.fsmonitor x"]],
  ["Bash(git -C * config alias.*)", ["config alias.st x", "config alias.p !sh"]],
  ["Bash(git -C * config hook.*)", ["config hook.x.command y"]],
  ["Bash(git -C * config include*)", ["config include.path /tmp/x", "config includeIf.onbranch:main.path /tmp/x"]],
  ["Bash(git -C * config url.*)", ["config url./tmp/x.insteadOf y"]],
  ["Bash(git -C * config set)", []], ["Bash(git -C * config set *)", ["config set user.name x", "config set core.hooksPath /tmp/h"]],
  ["Bash(git -C * config unset)", []], ["Bash(git -C * config unset *)", ["config unset core.x", "config unset user.name"]],
  ["Bash(git -C * update-ref)", []], ["Bash(git -C * update-ref *)", ["update-ref refs/heads/main HEAD~3", "update-ref -d refs/heads/main"]],
  ["Bash(git -C * symbolic-ref)", []], ["Bash(git -C * symbolic-ref *)", ["symbolic-ref HEAD refs/heads/x", "symbolic-ref -q HEAD refs/heads/x"]],
  ["Bash(git -C * filter-branch)", []], ["Bash(git -C * filter-branch *)", ["filter-branch --index-filter x HEAD", "filter-branch -f HEAD"]],
];
// f7 second attempt: tokens that are a whole word or path get a word boundary, as two rules each, the token ending the
// command (no rows in RULE_FORMS: the BOUNDARY test judges those with a person's extra `Bash(git *)` allow rule) and the
// token followed by a space and `*`.
const BOUNDARY = [
  "checkout .", "checkout :/", "restore .", "restore :/", "stash drop", "stash clear", "reflog expire", "reflog delete",
  "config set", "config unset", "update-ref", "symbolic-ref", "filter-branch",
];
/** The three spellings: the project folder and a later `status`, a quoted `-C` path holding a space and a later
 * `log`, a worktree and a later `add` (its pinned allow rule). @type {((f: string) => string)[]} */
const SPELL = [(f) => `git -C ${R} ${f} status`, (f) => `git -C "/tmp/a b" ${f} log --oneline`, (f) => `git -C ${WT} ${f} add x`];
/** @returns {[string, string][]} */
const ruleRows = () => RULE_FORMS.filter(([, forms]) => forms.length > 0).flatMap(([rule, forms]) =>
  Array.from({ length: Math.max(3, forms.length) }, (_, i) => /** @type {[string, string]} */ ([rule, SPELL[i % 3]?.(String(forms[i % forms.length])) ?? ""])));
// The two first-word rules: no default allow rule starts with `git --`, so their rows are judged with a person's extra
// allow rule `Bash(git *)` (ORCH_EXTRA_ALLOWED_TOOLS), which the base deny list let them through.
/** @type {[string, string[]][]} */
const FIRST_WORD = [
  ["Bash(git --git-dir*)", ['git --git-dir=../origin.git fetch "$PWD" main:main', 'git --git-dir="/tmp/a b/.git" update-ref refs/heads/main HEAD~3', "git --git-dir=../o.git branch -D main"]],
  ["Bash(git --work-tree*)", ["git --work-tree=../x checkout -- .", 'git --work-tree="/tmp/a b" checkout -f main', "git --work-tree=../x reset --merge HEAD~3"]],
];
const withGitStar = () => dryRunArgs({ ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "Bash(git *)", ORCH_SKILL_CREATE: "off" });

// Each row passed the headless rules before f3 (an allowed subcommand word later in the command lets a
// `git -C * <subcommand>*` rule match it) and is denied now. Rows the third attempt and f7 gave back are in LIMITS.
const CLOSED = [
  // the two examples of docs/safety.md
  `git -C ${R} branch -D main status`, `git -C ${R} checkout -- . diff`,
  // branch: delete, rename, force
  `git -C ${R} branch -d main status`, `git -C ${R} branch --delete main log`,
  `git -C ${R} branch -M x main status`, `git -C ${R} branch -m main old status`,
  `git -C ${R} branch --move main old status`, `git -C ${R} branch -f main HEAD~3 status`, `git -C ${R} branch --force main HEAD~3 log`,
  // checkout and switch that drop work or move a branch
  `git -C ${R} checkout -f main status`, `git -C ${R} checkout --force main status`, `git -C ${R} checkout . status`,
  `git -C ${R} checkout -B main HEAD~1 status`, `git -C ${R} checkout :/ status`,
  `git -C ${R} switch -f main status`, `git -C ${R} switch --force main status`, `git -C ${R} switch --discard-changes main status`,
  // restore
  `git -C ${R} restore . status`, `git -C ${R} restore --staged --worktree src diff`, `git -C ${R} restore -W src status`, `git -C ${R} restore :/ status`,
  // reset with a destructive option (reset --hard was closed before)
  `git -C ${R} reset --soft HEAD~3 status`, `git -C ${R} reset --mixed HEAD~3 status`, `git -C ${R} reset --keep HEAD~3 status`,
  // refs and history written directly
  `git -C ${R} update-ref refs/heads/main HEAD~3 status`, `git -C ${R} update-ref -d refs/heads/main log`, `git -C ${R} symbolic-ref HEAD refs/heads/x status`,
  `git -C ${R} gc --prune=now status`, `git -C ${R} reflog expire --expire=now --all status`, `git -C ${R} reflog delete HEAD@{1} status`,
  `git -C ${R} worktree remove --force ${WT} status`, `git -C ${R} worktree remove -f ${WT} log`, `git -C ${R} stash drop status`, `git -C ${R} stash clear status`,
  `git -C ${R} rebase -i HEAD~3 log`, `git -C ${R} rebase --onto x y main status`,
  `git -C ${R} filter-branch --index-filter x HEAD status`,
  // a fetch or pull with an option directly after it (audit J-11: in another repository a destination is a push)
  `git -C ../origin.git fetch --force "$PWD" main status`, `git -C ../origin.git fetch -f "$PWD" main status`,
  `git -C ../other pull --force "$PWD" main status`,
];

// Second attempt: the under-blocks a review found (clustered short options, reset --merge with more after it,
// checkout --ours) and rm -rf, tag -d, config, each passing the rules of ed139ef. `branch a b -m log` is in LIMITS, and
// so are the clustered rows and `reset --merge HEAD~3` since f7.
const REVIEW_ROWS = [
  `git -C ${R} reset -N HEAD~3 status`, `git -C ${R} checkout --ours . status`,
  `git -C ${R} rm -rf src status`, `git -C ${R} tag -d v1 status`, `git -C ${R} config core.hooksPath /tmp/h status`,
];

// Limits: forms a rule of the shape "subcommand word, one space, literal token" cannot reach, so they still pass
// when an allowed subcommand word follows. Each example of the "Out of reach" list in orchestrate.sh is a row here.
// Rows the earlier attempts denied and the third attempt or f7 gave back (their rules refused ordinary commit messages):
// moved here by name, with the comment `// moved` on their group.
const LIMITS = [
  // moved (f7, 34 rows that 3172119 denied: a `*` inside a rule is gone, so a cluster, an option the list does not
  // name, a long option cut short, a plain or pathspec-magic path and reset --merge with a revision pass again).
  // From CLOSED:
  `git -C ${R} branch --del main log`, `git -C ${R} branch -q -D main status`, `git -C ${R} branch -q -m main old status`, `git -C ${R} restore ${R}/src log`,
  `git -C ${R} reset -q HEAD~3 status`, `git -C ${R} reset -- . status`, `git -C ../origin.git fetch -o status "$PWD" main:main`,
  // from REVIEW_ROWS:
  `git -C ${R} reset --merge HEAD~3 status`, `git -C ${R} branch -qD main status`, `git -C ${R} branch -rd origin/main status`,
  `git -C ${R} checkout -qf main status`, `git -C ${R} switch -qf main status`,
  // from the RULE_FORMS rows of 3172119:
  `git -C ${WT} branch -rd origin/main add x`, `git -C "/tmp/a b" branch -qD main log --oneline`, `git -C ${WT} branch -qm main old add x`,
  `git -C "/tmp/a b" branch -qM x main log --oneline`, `git -C ${WT} branch -qf main HEAD~3 add x`, `git -C ${R} branch -qC x main status`,
  `git -C "/tmp/a b" branch -qC x main log --oneline`, `git -C ${WT} branch -qC x main add x`, `git -C ${WT} checkout -qf main add x`,
  `git -C "/tmp/a b" checkout :(top)src log --oneline`, `git -C ${R} checkout /abs/src status`, `git -C "/tmp/a b" checkout /r/src /r/doc log --oneline`,
  `git -C ${WT} checkout /abs/src add x`, `git -C ${WT} switch -qC main HEAD~3 add x`, `git -C "/tmp/a b" switch -m main log --oneline`,
  `git -C "/tmp/a b" restore :(top)src log --oneline`, `git -C ${R} restore /abs/src status`, `git -C "/tmp/a b" restore /r/src /r/doc log --oneline`,
  `git -C ${WT} restore /abs/src add x`, `git -C "/tmp/a b" fetch -o status "$PWD" main:main log --oneline`, `git -C ${WT} fetch -qf "$PWD" main add x`,
  `git -C ${WT} pull -q "$PWD" main:main add x`,
  // f7: an option the list does not name, after another option, and subcommands not listed (plumbing included)
  `git -C ${R} checkout -q -f main status`, `git -C ${R} switch -m main status`,
  `git -C ${R} read-tree -u --reset HEAD status`, `git -C ${R} checkout-index -f -a status`, `git -C ${R} prune --expire=now status`,
  // moved (f7 second attempt: the word boundary of `checkout .` and `restore .`; 2 rows of 3172119's RULE_FORMS), and a
  // path that starts with `.` or `:/` but is longer
  `git -C "/tmp/a b" checkout ./src log --oneline`, `git -C "/tmp/a b" restore ./src log --oneline`,
  `git -C ${R} checkout ./src status`, `git -C ${R} restore ./src status`, `git -C ${R} checkout :/src status`, `git -C ${R} restore :/src status`,
  // the destructive token after another word (moved: branch main -D, branch a b -m, the reordered SHAPES spellings,
  // checkout main -f in a worktree, reset main --soft, gc --aggressive --prune=now)
  `git -C ${R} branch main -D status`, `git -C ${R} branch a b -m log`, `git -C ${R} branch main -d diff`, `git -C ${R} branch main old -m diff`,
  `git -C ${R} branch main old -M diff`, `git -C ${R} branch main HEAD~3 -f diff`, `git -C ${R} branch x main --copy --force diff`,
  `git -C ${R} checkout main -f status`, `git -C ${R} checkout main -f diff`, `git -C ${WT} checkout main -f add x`, `git -C ${R} checkout HEAD~1 -B main diff`,
  `git -C ${R} checkout main --merge diff`, `git -C ${R} switch main --discard-changes status`, `git -C ${R} switch main --force diff`, `git -C ${R} switch main --merge diff`,
  `git -C ${R} restore src --staged diff`, `git -C ${R} reset main --soft status`, `git -C ${R} reset main --soft diff`, `git -C ${R} reset main -q status`,
  `git -C "/tmp/a b" reset main -q log --oneline`, `git -C ${R} gc --aggressive --prune=now log`, `git -C ${R} gc --aggressive --prune=now diff`,
  `git -C ${R} worktree remove /r/wt --force diff`, `git -C ${R} rebase main --onto x diff`, `git -C ${R} fetch "$PWD" main --force diff`,
  `git -C ${R} pull "$PWD" main --force diff`, `git -C ${R} rm src -r -f status`, `git -C ${R} rm src -r -f diff`, `git -C ${R} tag v1 -d status`,
  `git -C ${R} tag v1 -d diff`, `git -C ${R} tag v1 HEAD~3 -f diff`,
  // a path, or `--` and a path, after a revision or another path (moved: checkout HEAD -- src)
  `git -C ${R} checkout HEAD . status`, `git -C ${R} checkout main :/ status`, `git -C ${R} checkout main /abs/src status`,
  `git -C ${R} checkout HEAD -- src status`, `git -C "/tmp/a b" checkout HEAD -- src log --oneline`,
  `git -C ${R} restore src . status`, `git -C ${R} restore src :/ status`, `git -C ${R} restore src /abs status`,
  // a plain path, revision or branch name (moved: reset and rebase with HEAD, @ or *_HEAD)
  `git -C ${R} restore src status`, `git -C ${R} reset main status`, `git -C ${R} reset 0a1b2c3 status`, `git -C ${R} reset origin/main status`,
  `git -C ${R} reset HEAD~3 status`, `git -C "/tmp/a b" reset HEAD~3 log --oneline`, `git -C ${R} reset HEAD^ src diff`, `git -C ${R} reset @~3 status`,
  `git -C ${R} reset @{1} diff`, `git -C "/tmp/a b" reset @~3 log --oneline`, `git -C ${R} reset ORIG_HEAD status`, `git -C ${R} reset FETCH_HEAD src diff`,
  `git -C "/tmp/a b" reset ORIG_HEAD log --oneline`, `git -C ${R} rebase main status`, `git -C ${R} rebase HEAD~3 status`, `git -C ${R} rebase HEAD~3 main diff`,
  `git -C "/tmp/a b" rebase HEAD~3 log --oneline`, `git -C ${R} rebase @~3 status`, `git -C ${R} rebase @{u} diff`, `git -C "/tmp/a b" rebase @~3 log --oneline`,
  `git -C ${R} checkout main src status`, `git -C ${R} rm src status`, `git -C ../other pull "$PWD" main status`, `git -C ${R} worktree remove ${WT} status`,
  // a fetch or pull with a refspec destination after another word (moved: every refspec row; a rule for it refused
  // a commit message holding fetch or pull and a colon later)
  `git -C ../origin.git fetch "$PWD" main:main status`, `git -C ${R} fetch ../other +refs/heads/*:refs/heads/* log`, `git -C ../other pull "$PWD" main:main status`,
  `git -C ${WT} fetch ${R} main:main add x`, `git -C ${R} fetch "$PWD" main:main status`, `git -C "/tmp/a b" fetch "$PWD" main:main log --oneline`,
  `git -C ${R} pull "$PWD" main:main status`, `git -C "/tmp/a b" pull "$PWD" main:main log --oneline`,
  // a config key of another section or in another case
  `git -C ${R} config user.name x status`, `git -C ${R} config Core.hooksPath x status`,
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

// R2 corpus: subjects copied from `git log --format=%s -300` of this repository (every one holding branch, checkout,
// switch, restore, reset, rebase, rm, tag, config, fetch, pull, stash, worktree, clean or push, and a spread of the
// rest), stored here: no test reads git history.
const CORPUS_SUBJECTS = [
  "f3: deny clustered and reordered destructive options after git -C; reset beyond bare --merge; rm, tag, config; name limits",
  "f3: headless git -C destructive-form denies; orchestrator continue-branch and base checks; test-dashboard comment",
  "Merge branch 'worktree-agent-a5565d1f83d0e0554' into release-2.0.0",
  "Merge branch 'worktree-agent-a97feccb3f2774b38' into worktree-agent-a5565d1f83d0e0554",
  "Merge branch 'worktree-agent-a544992465059fdcb' into release-2.0.0",
  "Merge branch 'worktree-agent-ac1d031964c60422b' into release-2.0.0",
  "Merge branch 'worktree-agent-a27b49c6a0f81aee0' into release-2.0.0",
  "Merge branch 'worktree-agent-a73f2c5234998ca87' into release-2.0.0",
  "Merge branch 'worktree-agent-a9a22a7d620865da7' into release-2.0.0",
  "Join the release-1.6.1 branch history: its tree equals the published 1.6.1 (a21622b)",
  "w6 retry 2: follow every tag chain (at most 16 tag objects) and scan each tag object; blob and tree targets the push carries count",
  "w6 retry: scan every byte of each raw commit and tag object but its fixed-form id lines",
  "w4: claude-update checks payload fields, the memory switch and the loaded plugin's workflow (items 4, 5)",
  "Merge pull request #27 from 0xcvaliente/add-update-mac-copy",
  "Add workflow that updates the Mac copy on push to main",
  "Release 1.4.2: a test-gate hole closed, the workflow, parser, plan check and guards hardened, a turn warning and a worktree base check (#18)",
  "Worktree base check, turn warning, researcher coverage note and clearer gate messages (#16)",
  "Release 1.4.1: the Bash judge denies quoted exec-env assignments and find -rm, and no longer scans quadratically (#13)",
  "Bash judge: deny quoted exec-env assignments, find -rm, and fix the quadratic scan (#12)",
  "Let interactive sessions push; deny push on the command line for headless runs",
  "Merge slice r4-readme: README rewritten for 0.4.0 (diagrams, switch table, compare-040, limitations); baseline modes, skipped-skill and gap-cutoff wording",
  "s3-skill-prompts: restore missing space in nudge text",
  "h-test-gate: baseline inform by default (allow opt-in), runner-level crash markers, deps from the main worktree, process-group timeout, subdir in cache key",
  "c-profiler: WIP profiler core, fixtures, config",
  "judge: clamp the native judge timeout below the hook kill and deny symlinked or out-of-tree rm targets",
  "roles: implementer cannot spawn agents; fork subagents denied; tool policy synced from config.ts",
  "SDK workers: an opus judge decides git push, git remote and recursive rm; sudo and a narrow floor stay blocked",
  "dashboard: plan reviews are never slice cards, a new prompt starts a clean run, no stale ghost cards (0.1.12)",
  "Merge branch 'worktree-agent-a2a3486bf3062e286'",
  "Merge branch 'worktree-agent-aaf230b941ce7ec27'",
  "Merge branch 'worktree-agent-a3504f2e6862b2e6f'",
  "Merge branch 'worktree-agent-a165f93e16d760f08'",
  "Merge branch 'worktree-agent-a917f3e74f99b9bfc'",
  "Merge branch 'worktree-agent-a05e7a8cf495e26a2'",
  "Merge branch 'worktree-agent-ae26c6b29d0e5856a'",
  "Merge branch 'worktree-agent-a5f80f257663a4fed'",
  "Merge branch 'worktree-agent-a3a88b336f75649c4'",
  "Merge branch 'worktree-agent-a8bdd92a660dff2bb'",
  "Merge branch 'worktree-agent-a8dbc0391a8d447e0'",
  "headless allowlist: python checks and worktree merges",
  "Merge branch 'worktree-agent-a457dbb1ab525afa2'",
  "Merge branch 'worktree-agent-a567dc42d59f07df1'",
  "Merge branch 'worktree-agent-a1bd0a892ddc2b3f7'",
  "Merge branch 'worktree-agent-a4ad1d6b98d69e2fa'",
  "w7: string wrappers read every argument as a command string (S1); zsh stuck braces (S2)",
  "w2 retry 2: rebuild dist/plugin hooks",
  "w2 retry: attached and bundled zsh options, clone -c attached and abbreviated, find -exec as a command start, send-email prefixes, update-ref judged, prompts narrowed; native hook tracks directory changes",
  "w4: probe page (item 8: .mcp.json variable forms; claude-update checks)",
  "w4: /route passes the task through a quoted here-document (item 1)",
  "b2",
  "k5: pin headless git -C write rules; worker rows through the mod's AgentRow hook",
  "Second audit: Bash judge hardening, SDK, hook and pane fixes, README and diagrams (#23)",
  "Dashboard: open the pane by itself only inside herdr (#10)",
  "Release 1.1.0: first stable release (0.4.0 plus the escalation-aware finality fix, ORCH_SESSION_PERSISTENCE, the route-040 read-router benchmark and the agent.spawn probe); CHANGELOG.md with the stability statement; version test reads package.json",
  "f1-run-split: tests and dashboard mirror follow the new finality rule",
  "r4-readme: CLAUDE.md points to the renamed README sections",
  "r3-bench-report: compare-040 results page",
  "r2-docs: native-vs-plugin 0.4.0",
  "s2-skill-hints: a skipped suggestion goes in one report line, not under OPEN",
  "Merge slice j-wiring: register the 0.4.0 hooks (read log, guards, quote check, compact context), judge onFailure block, hook timeouts, userConfig, version 0.4.0, rebuilt plugin",
  "i-router: quote-check tests",
  "g-review-gate: VALIDATE wording in brief grammar",
  "e-guards: deny any heredoc or here-string in researcher commands (review GAP 30); note GAP 25",
  "b-telemetry",
  "c-profiler: file profiler tests and CI poppler",
  "docs: harness research 2026-10-31 (file-type model routing, harness survey, final verdict)",
  "Merge slice B3: plugin eval suite",
  "Merge slice A1: async-aware, run-scoped gates",
  "Merge slice A2: role lockdown",
  "statusline: ship the status line script, an installer and a test",
  "s2-parity",
  "test: make the reviewed-route truncation check deterministic",
  "docs: final benchmark results (review fix)",
];
// f7: commit messages that mention a git command with a harmless option, or followed by ordinary words. The rules of
// 3172119 refused the first three (a `*` inside `branch -*d*`, `-*m*` or `-*f*` reached a later d, m or f, as in
// "before it merges" or "Body - details."): F3_BRANCH_RULES below.
const CORPUS_MESSAGES = [
  "integrator: confirm git branch --show-current before it merges", "check branch --show-current and rev-parse HEAD",
  "use git branch --contains <base>", "docs: branch --list output", "branch -a shows remotes", "branch -r and branch -v in the report",
  "git branch --merged lists the done slices", "explain git reset --merge", "run git reset --merge then retry",
  "git merge --abort, then git reset --merge", "after git reset --merge HEAD stays", "git checkout main, then build",
  "fix the checkout flow - cart restore", "update config loader", "read config.ts first", "update config settings page",
  "rm the temp folder", "tag the release", "git tag -l lists releases", "fetch the page - then parse", "git fetch --prune notes",
  "pull request #29", "git pull --ff-only from main", "rebase notes", "rebase onto main", "restore the cart",
  "restore src after the fix", "switch to opus for reviews", "switch main in the docs", "stash handling in the pane",
  "git stash list in the report", "worktree list shows the branch", "worktree remove after the merge", "gc notes",
  "reflog is not used", "add the branch name to the report", "docs: checkout flow -- notes", "checkout main and switch main",
  // second attempt: a whole-word token followed by more letters or dots (the word boundary)
  "fix stash dropdown styling", "Fix checkout ... flow", "stash cleared state in the pane", "reflog expired entries are ignored",
  "config settings page", "config unsettled", "update-reference docs", "restore ... later",
  // a form at the very start of a quoted argument: the quote stands where the rule's space would
  "branch -D old", "rm -r the folder",
];
// O1: messages that quote a denied form verbatim after a space. Allowed before f3, refused now (the comment's "Also
// refused" line).
const O1_MESSAGES = [
  "remove with git branch -D old", "never run git checkout -- .", "use git rm -r for folders", "rename with git branch -m old new",
  "git tag -d v1 removes the tag", "git rebase -i squashes", "git reset --soft HEAD~1 keeps the changes", "git stash drop loses the entry",
  "git config core.hooksPath in tests", "git restore --staged unstages", "git switch --discard-changes drops work",
  "git fetch --force overwrites", "git worktree remove --force cleans up", "git update-ref moves a ref",
  "see branch -D old", "use rm -r the folder",
];
// O1 across two arguments: two file names make up `config -` (the comment's example).
const O1_COMMANDS = [`git -C ${WT} add config -f`];
const corpus = () => [
  ...CORPUS_SUBJECTS.flatMap((s) => [
    `git -C ${WT} commit -m "${s}"`,
    `git -C ${WT} commit -m "${s}" -m "Body - details. See docs/config.md."`,
    `git -C ${WT} commit -m "${s}" -m "Refs: a:b, c:d -- notes"`,
  ]),
  // the four commands the second attempt's rules refused
  `git -C ${WT} commit -m "fix: reset the cache" -m "Body."`, `git -C ${WT} commit -m "fix: update config loader" -m "See docs."`,
  `git -C ${WT} commit -m "add the branch name to the report" -m "Body - details."`, `git -C ${WT} commit -m "docs: checkout flow -- notes"`,
  `git -C ${WT} add src/config.ts`, `git -C ${WT} add src/checkout/restore.ts`, `git -C ${WT} diff -- src/config.ts`, `git -C ${WT} log -- src/tag.ts`,
  `git -C ${WT} status -- scripts/rm.sh`, `git -C ${WT} ls-files src/reset.ts`, `git -C ${WT} show HEAD:src/x.ts`, `git -C ${WT} diff main:src/a.ts branch:src/a.ts`,
  `git -C ${WT} log --format=%H:%s -3`, `git -C ${WT} branch --show-current`, `git -C ${WT} worktree list`, `git -C ${WT} merge --abort`,
  `git -C ${R} reset --merge`, `git -C ${R} merge --no-ff --no-edit branch`,
  // f7: messages that mention a git command with a harmless option, or followed by ordinary words
  ...CORPUS_MESSAGES.flatMap((s) => [`git -C ${WT} commit -m "${s}"`, `git -C ${WT} commit -m "${s}" -m "Body - details."`]),
];

test("orchestrate.sh dry run (f3): the deny list is b0f1388's, in order, then GIT_C_DESTRUCTIVE_DENY, each rule with its rows", () => {
  const args = headless();
  assert.deepEqual(denied(args).slice(0, BASE_DENY.length), BASE_DENY);
  assert.equal(newRules(args).length, 70, newRules(args).join("\n"));
  assert.deepEqual([...RULE_FORMS.map(([r]) => r), ...FIRST_WORD.map(([r]) => r)], newRules(args));
});

test("orchestrate.sh dry run (f7): each `git -C` deny rule is the folder's `*`, a literal with no `*`, then one of three endings", () => {
  // The literal is the subcommand word (two words for `worktree remove`), one space and a token (none for update-ref,
  // symbolic-ref and filter-branch). An option or key prefix ends in `*`; a BOUNDARY token has exactly two rules, the
  // literal ending the command and the literal, a space and `*`.
  const rules = newRules(headless()).filter((r) => !FIRST_WORD.some(([f]) => f === r));
  assert.equal(rules.length, 68);
  for (const rule of rules) {
    const m = /^Bash\(git -C \* (.+?)( \*|\*|)\)$/.exec(rule);
    assert.ok(m, rule);
    const literal = String(m?.[1]);
    const ending = String(m?.[2]);
    assert.ok(!literal.includes("*"), `${rule}: a \`*\` inside the pattern`);
    assert.ok(/^(worktree remove|[a-z-]+)( [^\s*]+)?$/.test(literal), `${rule}: not "<subcommand> <token>"`);
    if (BOUNDARY.includes(literal)) assert.notEqual(ending, "*", `${rule}: a whole-word token needs a word boundary`);
    else assert.equal(ending, "*", `${rule}: a prefix token ends in \`*\``);
  }
  for (const t of BOUNDARY) {
    assert.ok(rules.includes(`Bash(git -C * ${t})`) && rules.includes(`Bash(git -C * ${t} *)`), t);
  }
  assert.equal(rules.filter((r) => !r.endsWith("*)")).length, BOUNDARY.length);
  // The two first-word rules keep their shape.
  assert.deepEqual(FIRST_WORD.map(([r]) => r), ["Bash(git --git-dir*)", "Bash(git --work-tree*)"]);
});

test("orchestrate.sh dry run (f7): each word-boundary pair denies the plain form, further arguments and a later allowed word", () => {
  // The plain form and the form with arguments need a person's extra `Bash(git *)` allow rule to pass the base rules;
  // the form with a later allowed word passes them with the default rules.
  const extra = withGitStar();
  const args = headless();
  for (const t of BOUNDARY) {
    for (const dir of [R, `"/tmp/a b"`, WT]) {
      for (const cmd of [`git -C ${dir} ${t}`, `git -C ${dir} ${t} x`]) {
        assert.ok(basePermitted(extra, cmd), `${cmd} must pass the rules before f3 with Bash(git *) allowed`);
        assert.equal(permitted(extra, cmd), false, cmd);
      }
    }
    const later = `git -C ${R} ${t} status`;
    assert.ok(basePermitted(args, later), later);
    assert.equal(permitted(args, later), false, later);
    // the boundary: more letters or dots after the token pass
    const longer = `git -C ${WT} commit -m "x ${t}x"`;
    assert.equal(permitted(args, longer), basePermitted(args, longer), longer);
  }
});

test("orchestrate.sh dry run (f7): the allow rules the comment names: seven with the folder as `*`, three with a worktree's name as `*`", () => {
  const rules = allowed(headless()).filter((r) => r.startsWith("Bash(git -C "));
  const folderStar = rules.filter((r) => r.startsWith("Bash(git -C * "));
  assert.equal(folderStar.length, 7, folderStar.join("\n"));
  for (const r of folderStar) assert.ok(/^Bash\(git -C \* [a-z-]+\*\)$/.test(r), r);
  const worktreeStar = rules.filter((r) => r.includes("/.claude/worktrees/* "));
  assert.equal(worktreeStar.length, 3, worktreeStar.join("\n"));
  // that `*` holds a whole subcommand: the docs' example passes the base rules through `git -C * status*`
  assert.deepEqual(hits(allowed(headless()), `git -C /r branch -D main status`), ["Bash(git -C * status*)"]);
  assert.ok(basePermitted(headless(), `git -C ${WT} branch -D main add x`));
});

// The branch rules of 3172119, stored here (no git read): each had a `*` inside.
const F3_BRANCH_RULES = ["d", "D", "m", "M", "f", "C"].map((l) => `Bash(git -C * branch -*${l}*)`);

test("orchestrate.sh dry run (f7): commit messages 3172119's branch rules refused get the base's decision back", () => {
  const args = headless();
  for (const msg of CORPUS_MESSAGES.slice(0, 3)) {
    const forms = [`git -C ${WT} commit -m "${msg}"`, `git -C ${WT} commit -m "${msg}" -m "Body - details."`];
    assert.ok(forms.some((cmd) => hits(F3_BRANCH_RULES, cmd).length > 0), `${msg}: 3172119 let it through`);
    for (const cmd of forms) {
      assert.ok(basePermitted(args, cmd), cmd);
      assert.equal(permitted(args, cmd), true, `${cmd}: ${hits(denied(args), cmd).join(", ")}`);
    }
  }
});

test("orchestrate.sh dry run (f7): O1, a commit message that quotes a denied form verbatim, is refused (allowed before f3)", () => {
  const args = headless();
  assert.ok(O1_MESSAGES.length >= 8);
  for (const msg of O1_MESSAGES) {
    for (const cmd of [`git -C ${WT} commit -m "${msg}"`, `git -C ${WT} commit -m "${msg}" -m "Body - details."`]) {
      assert.ok(basePermitted(args, cmd), `${cmd} must pass the rules before f3`);
      assert.equal(permitted(args, cmd), false, cmd);
    }
  }
  // across two arguments
  for (const cmd of O1_COMMANDS) {
    assert.ok(basePermitted(args, cmd), `${cmd} must pass the rules before f3`);
    assert.deepEqual(hits(newRules(args), cmd), ["Bash(git -C * config -*)"], cmd);
    assert.equal(permitted(args, cmd), false, cmd);
  }
  // the comment's pair: a form after a space is refused, the same form at the very start of the quoted argument passes
  /** @type {[string, string][]} */
  const pairs = [["see branch -D old", "branch -D old"], ["use rm -r the folder", "rm -r the folder"]];
  for (const [refused, passes] of pairs) {
    assert.equal(permitted(args, `git -C ${WT} commit -m "${refused}"`), false, refused);
    assert.equal(permitted(args, `git -C ${WT} commit -m "${passes}"`), true, passes);
  }
});

test("orchestrate.sh dry run (f3): destructive git forms that an allow rule's `*` absorbed are denied", () => {
  const args = headless();
  for (const cmd of CLOSED) {
    assert.ok(basePermitted(args, cmd), `${cmd} must pass the rules before f3`);
    assert.equal(permitted(args, cmd), false, `${cmd} is allowed by ${hits(allowed(args), cmd).join(", ")}`);
  }
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
  for (const cmd of REVIEW_ROWS) {
    assert.ok(basePermitted(args, cmd), `${cmd} must pass the rules before f3`);
    assert.equal(permitted(args, cmd), false, `${cmd} is allowed by ${hits(allowed(args), cmd).join(", ")}`);
  }
});

test("orchestrate.sh dry run (f3): each deny rule denies its rows in three spellings, each allowed before f3", () => {
  const args = headless();
  for (const [rule, cmd] of ruleRows()) {
    assert.ok(basePermitted(args, cmd), `${cmd}: the row must pass the rules before f3`);
    assert.ok(hits(newRules(args), cmd).includes(rule), `${cmd} is not denied by ${rule}`);
    assert.equal(permitted(args, cmd), false, cmd);
  }
  const extra = withGitStar();
  for (const [rule, cmds] of FIRST_WORD) {
    for (const cmd of cmds) {
      assert.ok(basePermitted(extra, cmd), `${cmd}: the row must pass the rules before f3 with Bash(git *) allowed`);
      assert.ok(hits(newRules(extra), cmd).includes(rule), `${cmd} is not denied by ${rule}`);
      assert.equal(permitted(extra, cmd), false, cmd);
    }
  }
});

test("orchestrate.sh dry run (f3): the out-of-reach forms named in orchestrate.sh still pass (limits, not fixed)", () => {
  const args = headless();
  for (const cmd of LIMITS) {
    assert.ok(basePermitted(args, cmd), `limit ${cmd} must pass the rules before f3`);
    assert.equal(permitted(args, cmd), true, `limit ${cmd} is now denied by ${hits(denied(args), cmd).join(", ")}: update the "Out of reach" list in orchestrate.sh`);
  }
  // Every example of the comment's "Out of reach" list is a LIMITS row (with <path> as "$PWD" and <worktree> as WT).
  const sh = readFileSync(orchestrateSh, "utf8").split("\n");
  const from = sh.findIndex((l) => l.startsWith("# Out of reach"));
  const to = sh.findIndex((l, i) => i > from && l.startsWith("# This list stops mistakes"));
  assert.ok(from > 0 && to > from, "orchestrate.sh has the Out of reach list");
  const examples = [...sh.slice(from, to).join("\n").matchAll(/`([^`]+)`/g)].map((m) => String(m[1]));
  assert.ok(examples.length >= 25, examples.join(" | "));
  for (const ex of examples) {
    const row = ` ${ex.replace("<path>", '"$PWD"').replace("<worktree>", WT)}`;
    assert.ok(LIMITS.some((r) => r.includes(row)), `the limit ${ex} named in orchestrate.sh has no LIMITS row`);
  }
});

test("orchestrate.sh dry run (f3, third attempt): the ordinary commands of the corpus get the same decision as before f3", () => {
  const args = headless();
  assert.ok(CORPUS_SUBJECTS.length >= 60, String(CORPUS_SUBJECTS.length));
  assert.ok(CORPUS_MESSAGES.length >= 25, String(CORPUS_MESSAGES.length));
  const cmds = corpus();
  const changed = cmds.filter((cmd) => permitted(args, cmd) !== basePermitted(args, cmd));
  assert.deepEqual(changed.map((cmd) => `${cmd} -> ${hits(newRules(args), cmd).join(", ")}`), []);
  // Most of them are allowed (a subject holding " push", " remote", " -c" or " -C " was refused before f3 already).
  assert.ok(cmds.filter((cmd) => permitted(args, cmd)).length >= cmds.length - 30);
});

test("orchestrate.sh dry run (f3, second attempt): commit messages the earlier rules refused get their decision from before f3 back", () => {
  const args = headless();
  // The second attempt refused these (a subcommand word in the message, followed later by an option word or the
  // phrase a wider rule named); the rules of this attempt need the token directly after the word.
  for (const cmd of [
    `git -C ${WT} commit -m "fix branch handling" -m "More"`, `git -C ${WT} commit -m "fix: reset cache" -- src/a.ts`, `git -C ${WT} commit -m "update config files. Done"`,
    `git -C ${WT} commit -m "fix checkout page" --no-verify`, `git -C ${WT} commit -m "fix: rm stale file" -- src/a.ts`, `git -C ${WT} commit -m "move tag" -m "details"`,
    `git -C ${WT} commit -m "fix fetch of a:b pairs"`, `git -C ${WT} commit -m "fix: reset HEAD handling"`,
  ]) {
    assert.ok(basePermitted(args, cmd), cmd);
    assert.equal(permitted(args, cmd), true, `${cmd}: ${hits(denied(args), cmd).join(", ")}`);
  }
});

test("orchestrate.sh dry run (f3): stated over-blocks and limits, pinned so a change to them is seen", () => {
  const args = headless();
  // Over-blocks: a deny rule cannot tell a commit message from a subcommand, so a message holding a denied form (the
  // subcommand word, one space, its token) is refused (O1). The push one predates f3 (a deny that goes away
  // would widen the rules).
  assert.equal(permitted(args, `git -C ${WT} commit -m "fix: push the button"`), false);
  for (const cmd of [
    `git -C ${WT} commit -m "drop the branch -D shortcut"`, `git -C ${WT} commit -m "guard rm -rf in scripts"`,
    `git -C ${WT} commit -m "docs: checkout -- paths"`, `git -C ${WT} commit -m "judge update-ref calls"`,
  ]) {
    assert.ok(basePermitted(args, cmd), cmd);
    assert.equal(permitted(args, cmd), false, cmd);
  }
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
