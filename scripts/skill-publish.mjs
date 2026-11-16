#!/usr/bin/env node
// Publishes a draft skill that a skill slice created (docs/skills.md, "Publishing"). A person runs it; no agent and no
// hook does: it is the only part of this repo that pushes a skill branch, opens its pull request or installs a skill.
//
//   npm run skill-publish                       lists the drafts
//   npm run skill-publish -- <name> [--target private|public] [--base <branch>] [--merge] [--install "<command>"] [--dry-run]
//
// A draft is a git worktree of a skills repository at <CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/skill-drafts/
// <target>/<name>, on branch skill/<name>. The target is private unless --target says otherwise; without --target, a
// name that exists only under public is taken from there. Steps, in order; the first that fails stops the script with
// exit 1 and says what to do (bad usage exits 2):
//   1. seal       skills/<name>/provenance.json matches the files (skill-seal.mjs verify) and names this target.
//   2. validate   python3 -I -B scripts/validate.py skills/<name> exits 0 in the draft.
//   3. git state  the draft is clean, on skill/<name>, and the branch has a commit its base does not; every file under
//                 skills/<name> is committed on the branch (an ignored or untracked file is sealed but never pushed).
//                 The base is --base, else the branch the repository's main checkout is on (the one the draft was made
//                 from). The branch's head commit is recorded here.
//   4. scan       the skill gate's branch scan (.claude/hooks/skill-scan.mjs): every line any commit between the
//                 branch's merge base with the base and its tip adds, on every path, has no secret or personal detail
//                 (a finding only in an earlier commit is named with that commit: the push carries the history), and
//                 those commits change only skills/<name>/ and README.md. A branch with no merge base is refused. It
//                 compares with the push target, not origin's fetch address: every address git remote get-url --push
//                 --all origin names (pushurl, pushInsteadOf, several URLs) is read with git ls-remote, and a commit
//                 counts as there only when every one of them has it. The commits a push would send below the merge
//                 base (base commits an address lacks, on whatever local branch) are scanned too, and refused, since
//                 the pull request would carry them. Refused as unclear: an address that cannot be read, one git
//                 would rewrite again when reading it, no address, and origin set up as a mirror.
//   5. push       refused when skill/<name> exists at any push address and is neither that head nor an ancestor of it
//                 (commits the seal never covered); else git push --recurse-submodules=no --no-follow-tags -u origin
//                 skill/<name>:skill/<name> (never a force push; remote and refspec named, so remote.pushDefault,
//                 branch.<name>.pushRemote and remote.origin.push cannot redirect it; no tag is sent, whatever
//                 push.followTags says, since tag messages are never scanned).
//   6. PR         gh pr create against the base, its body naming the skill, target, provenance digest and that an agent
//                 created it and a person must review it; an open PR for the branch is reused. Prints the URL.
// With --merge, after those:
//   7. merge      gh pr merge <url> --merge --match-head-commit <the head recorded in step 3>, so gh merges only
//                 when the pull request's head is still the commit that was checked.
//   8. update     the main checkout fetches origin and fast-forwards its base branch (git merge --ff-only).
//   9. install    --install "<command>" run with sh in the main checkout, else scripts/install.sh --target claude when
//                 that file exists, else skipped with a note.
//  10. clean up   git worktree remove <draft>, then git branch -d skill/<name> (a failure there is only a note).
// --dry-run prints each step and its command without running any of them (it still finds the draft and its
// repository), except step 4, which only reads and runs in the dry run too, refusing with the same findings.
// Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSkillName } from "../.claude/hooks/brief.mjs";
import { findingLine, historyAdvice, outsideText, scanBranch, unpushedText } from "../.claude/hooks/skill-scan.mjs";
import { verify } from "../.claude/hooks/skill-seal.mjs";

const TARGETS = /** @type {const} */ (["private", "public"]);
const USAGE = 'usage: npm run skill-publish -- [<name>] [--target private|public] [--base <branch>] [--merge] [--install "<command>"] [--dry-run]';

/** @param {string} msg @param {number} [code] @returns {never} */
function fail(msg, code = 1) {
  process.stderr.write(`skill-publish: ${msg}\n`);
  process.exit(code);
}

/**
 * Run a program without a shell; never throws.
 * @param {string} cmd @param {string[]} args @param {{ cwd?: string, timeout?: number, input?: string }} [opts]
 * @returns {{ ok: boolean, out: string, err: string }}
 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeout ?? 120_000, input: opts.input, stdio: ["pipe", "pipe", "pipe"] });
  const err = r.error ? r.error.message : String(r.stderr ?? "");
  return { ok: r.status === 0 && !r.error, out: String(r.stdout ?? "").trim(), err: err.trim() };
}

/** @param {string} dir @param {string[]} args */
const git = (dir, args) => run("git", ["-C", dir, ...args]);

/** The last lines of a program's output, for an error message. @param {{ out: string, err: string }} r */
const tail = (r) => `${r.out}\n${r.err}`.trim().split("\n").slice(-15).join("\n");

/** A word for a printed command line, single-quoted unless it is plain. @param {string} s */
const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// ---- arguments ----
const argv = process.argv.slice(2);
/** @type {{ name: string | null, target: 'private' | 'public' | null, base: string | null, merge: boolean, install: string | null, dryRun: boolean }} */
const opt = { name: null, target: null, base: null, merge: false, install: null, dryRun: false };
for (let i = 0; i < argv.length; i++) {
  const a = /** @type {string} */ (argv[i]);
  if (a === "--merge") opt.merge = true;
  else if (a === "--dry-run") opt.dryRun = true;
  else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--target" || a === "--base" || a === "--install") {
    const v = argv[++i];
    if (v === undefined || v === "") fail(`${a} needs a value\n${USAGE}`, 2);
    if (a === "--target") {
      if (v !== "private" && v !== "public") fail(`--target must be private or public, not ${v}`, 2);
      opt.target = v;
    } else if (a === "--base") opt.base = v;
    else opt.install = v;
  } else if (a.startsWith("-")) fail(`unknown option ${a}\n${USAGE}`, 2);
  else if (opt.name === null) opt.name = a;
  else fail(`one skill name at a time\n${USAGE}`, 2);
}

const home = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "orchestration", "skill-drafts");

/** @param {string} p */
const isDir = (p) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

// ---- no name: list the drafts ----
if (opt.name === null) {
  /** @type {string[]} */
  const rows = [];
  for (const target of TARGETS) {
    const dir = join(home, target);
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => isDir(join(dir, n))).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const draft = join(dir, n);
      const branch = git(draft, ["branch", "--show-current"]);
      const sealed = isSkillName(n) ? verify(join(draft, "skills", n)).ok : false;
      rows.push(`  ${n}  (${target}, ${branch.ok && branch.out ? `branch ${branch.out}` : "not a git worktree"}, seal ${sealed ? "ok" : "not ok"})  ${draft}`);
    }
  }
  if (!rows.length) {
    console.log(`No draft skills in ${home}.`);
  } else {
    console.log(`Draft skills in ${home}:`);
    for (const r of rows) console.log(r);
    console.log(`Publish one with: npm run skill-publish -- <name> [--target private|public] [--merge] [--dry-run]`);
  }
  process.exit(0);
}

// ---- name, target, draft ----
const name = opt.name;
if (!isSkillName(name)) fail(`"${name}" is not a valid skill name: lower-case letters and digits in words joined by single hyphens, at most 64 characters.`, 2);
const inPrivate = isDir(join(home, "private", name));
const inPublic = isDir(join(home, "public", name));
const target = opt.target ?? (inPublic && !inPrivate ? "public" : "private");
const draft = join(home, target, name);
const branch = `skill/${name}`;
const skillDir = join(draft, "skills", name);
if (!isDir(draft)) {
  const other = target === "private" ? inPublic : inPrivate;
  fail(
    `no draft "${name}" under ${target} (${draft}).${other ? ` There is one under ${target === "private" ? "public" : "private"}: pass --target ${target === "private" ? "public" : "private"}.` : ""} Run npm run skill-publish with no name to list the drafts.`,
  );
}
const top = git(draft, ["rev-parse", "--show-toplevel"]);
/** @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (!top.ok || real(top.out) !== real(draft)) fail(`${draft} is not a git worktree. Remove the folder and let the skill slice create the draft again, or create it with git worktree add.`);
// The main checkout: the first entry of git worktree list.
const list = git(draft, ["worktree", "list", "--porcelain"]);
const mainCheckout = list.ok ? (list.out.match(/^worktree (.+)$/m)?.[1] ?? null) : null;
if (!mainCheckout || !isDir(mainCheckout)) fail(`cannot find the skills repository's main checkout from ${draft} (git worktree list failed).`);
let base = opt.base;
if (!base) {
  const b = git(mainCheckout, ["branch", "--show-current"]);
  if (!b.ok || !b.out) fail(`the main checkout ${mainCheckout} is on no branch. Pass the branch the pull request should go to with --base <branch>.`, 2);
  base = b.out;
}
const baseBranch = base;

console.log(`Skill ${name} (${target})\n  draft:      ${draft}\n  repository: ${mainCheckout}\n  branch:     ${branch} -> ${baseBranch}${opt.dryRun ? "\n  dry run:    nothing below is run" : ""}`);

// An agent never publishes: Claude Code marks the shells it starts with CLAUDECODE=1.
if (!opt.dryRun && process.env.CLAUDECODE === "1") fail("this runs inside a Claude Code session. A person publishes a draft skill: run it in your own terminal (or add --dry-run to see the steps).");

let stepNo = 0;
/**
 * One step: print it; in a dry run print its command and stop there, else run it. A step marked `always` only reads,
 * so it runs in a dry run too.
 * @param {string} label @param {string} shown the command or action, as printed @param {() => void} act @param {boolean} [always]
 */
function step(label, shown, act, always = false) {
  stepNo++;
  console.log(`${stepNo}. ${label}${opt.dryRun && !always ? `\n   would run: ${shown}` : ""}`);
  if (!opt.dryRun || always) act();
}

// 1. seal
/** @type {any} */
let provenance = null;
step("Verify the seal", `skill-seal verify ${skillDir}`, () => {
  const v = verify(skillDir);
  if (!v.ok) fail(`the seal of ${skillDir} does not match its files:\n  - ${v.problems.join("\n  - ")}\nA sealed draft changed after its review. Have it reviewed again, then seal it: node .claude/hooks/skill-seal.mjs ${skillDir}, and commit.`);
  try {
    provenance = JSON.parse(readFileSync(join(skillDir, "provenance.json"), "utf8"));
  } catch {
    fail(`cannot read ${join(skillDir, "provenance.json")}.`);
  }
  if (provenance.target !== target) fail(`the seal says target ${String(provenance.target)}, but the draft is under ${target}. Publish it with --target ${String(provenance.target)}, or seal it again with --target ${target} after a review.`);
  console.log(`   ok, digest ${String(provenance.digest)}`);
});

// 2. validator
step("Run the repository validator", `python3 -I -B scripts/validate.py skills/${name}  (in ${draft})`, () => {
  if (!existsSync(join(draft, "scripts", "validate.py"))) fail(`${draft} has no scripts/validate.py. Is this a skills repository?`);
  const r = run("python3", ["-I", "-B", "scripts/validate.py", `skills/${name}`], { cwd: draft, timeout: 120_000 });
  if (!r.ok) fail(`the validator failed:\n${tail(r)}\nFix the draft in ${draft}, seal it again, commit, and rerun.`);
  console.log("   ok");
});

/** Every regular file under `dir`, as paths relative to it with "/" separators (links and the like are left to the seal). @param {string} dir */
function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    for (const n of readdirSync(abs).sort()) {
      const a = join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(a);
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile()) out.push(r);
    }
  };
  walk(dir, "");
  return out;
}

// 3. git state
let localHead = "";
step("Check the draft is clean and committed", `git status, git branch --show-current, git rev-list --count ${baseBranch}..${branch}`, () => {
  const st = git(draft, ["status", "--porcelain"]);
  if (!st.ok) fail(`git status failed in ${draft}:\n${tail(st)}`);
  if (st.out) fail(`the draft has uncommitted changes:\n${st.out}\nCommit them on ${branch} (after sealing) or discard them, then rerun.`);
  const cur = git(draft, ["branch", "--show-current"]);
  if (cur.out !== branch) fail(`the draft is on ${cur.out || "no branch"}, not ${branch}. Check out ${branch} in ${draft}.`);
  const ahead = git(draft, ["rev-list", "--count", `${baseBranch}..${branch}`]);
  if (!ahead.ok) fail(`cannot compare ${branch} with ${baseBranch}:\n${tail(ahead)}\nPass the right base with --base <branch>.`);
  if (Number(ahead.out) < 1) fail(`${branch} has no commit that ${baseBranch} lacks. Commit the draft on ${branch} first.`);
  // The seal covers every file on disk, ignored ones too, and git status hides ignored files: each must be on the branch.
  const tree = git(draft, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", `refs/heads/${branch}`, "--", `skills/${name}`]);
  if (!tree.ok) fail(`cannot list the files of ${branch}:\n${tail(tree)}`);
  const onBranch = new Set(tree.out.split("\0").filter(Boolean));
  /** @type {string[]} */
  let onDisk = [];
  try {
    onDisk = filesUnder(skillDir).map((r) => `skills/${name}/${r}`);
  } catch (e) {
    fail(`cannot list the files of ${skillDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const missing = onDisk.filter((p) => !onBranch.has(p));
  if (missing.length) fail(`${missing.length} file${missing.length === 1 ? "" : "s"} under skills/${name} ${missing.length === 1 ? "is" : "are"} not committed on ${branch} (ignored or untracked), so the pushed branch would lack what the seal lists:\n  - ${missing.join("\n  - ")}\nCommit each (git add -f for an ignored one) or delete it and seal again, then rerun.`);
  const h = git(draft, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (!h.ok || !/^[0-9a-f]{40,64}$/.test(h.out)) fail(`cannot read the head commit of ${branch}:\n${tail(h)}`);
  localHead = h.out;
  console.log(`   ok, ${ahead.out} commit${ahead.out === "1" ? "" : "s"} ahead of ${baseBranch}`);
});

/** An address as printed: any user name or password in it masked. @param {string} u */
const shownUrl = (u) => u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1***@");

/**
 * Where `git push origin <branch>:<branch>` sends the branch, and what each of those addresses has. The push names the
 * remote and the refspec, so remote.pushDefault, branch.<name>.pushRemote and remote.origin.push never redirect it;
 * the addresses are origin's push URLs as git resolves them (pushurl, else url, after pushInsteadOf and insteadOf
 * rewrites; several when several are set), each read with git ls-remote. Anything unclear stops the publish: origin
 * set up as a mirror, no push URL, a URL git would rewrite again when it is read, or one that cannot be read.
 * @returns {{ url: string, refs: Map<string, string> }[]} each address, with its refs (name to commit id)
 */
function pushTargets() {
  const stop = (/** @type {string} */ why) => fail(`${why} Nothing was pushed.`);
  const mirror = git(draft, ["config", "--type=bool", "--get", "remote.origin.mirror"]);
  if (mirror.out !== "" && mirror.out !== "false") stop(`origin is set up as a mirror (remote.origin.mirror is ${mirror.out}): a push to it would not be the branch push that is checked here. Unset it (git config --unset remote.origin.mirror) or publish by hand.`);
  const urls = git(draft, ["remote", "get-url", "--push", "--all", "origin"]);
  if (!urls.ok) stop(`cannot tell where a push to origin goes (git remote get-url --push failed), so what it would send cannot be checked.\n${shownUrl(tail(urls))}`);
  const list = [...new Set(urls.out.split("\n").filter((u) => u !== ""))];
  if (!list.length) stop("origin has no push address, so what a push would send cannot be checked.");
  return list.map((url, i) => {
    const which = `origin's push address ${list.length > 1 ? `${i + 1} of ${list.length} ` : ""}(${shownUrl(url)})`;
    if (url.startsWith("-")) stop(`cannot read ${which}: it starts with "-".`);
    // ls-remote applies insteadOf rewrites to a URL it is given: read only a URL it leaves as it is.
    const as = git(draft, ["ls-remote", "--get-url", "--", url]);
    if (!as.ok || as.out !== url) stop(`cannot read ${which} as the push would reach it: git rewrites it again when reading it (to ${shownUrl(as.out) || "nothing"}). Simplify origin's url.<base>.insteadOf and pushInsteadOf settings, then rerun.`);
    const ls = git(draft, ["ls-remote", "--", url]);
    if (!ls.ok) stop(`cannot read ${which} (git ls-remote failed), so what a push would send there cannot be checked.\n${shownUrl(tail(ls))}`);
    /** @type {Map<string, string>} */
    const refs = new Map();
    for (const l of ls.out.split("\n")) {
      const [id = "", ref = ""] = l.split(/\s+/);
      if (/^[0-9a-f]{40,64}$/.test(id)) refs.set(ref, id);
    }
    return { url, refs };
  });
}

// 4. the branch scan, the skill gate's own (skill-scan.mjs): the push carries every commit, so every line any commit
// adds is scanned, on every path, and the branch may change only skills/<name>/ and README.md. Read-only, so it runs in
// a dry run too.
step(
  "Scan the branch for secrets and paths outside the skill",
  `every line the commits of ${branch} add since its merge base with ${baseBranch}, and the paths they change`,
  () => {
    // What each address the push goes to has now: the push sends every commit of the branch that an address's refs
    // do not reach, whichever local branch it sits on. A commit counts as there only when every address has it.
    const targets = pushTargets();
    const remotes = targets.map((t) => [...new Set(t.refs.values())]);
    const scan = scanBranch(draft, { base: baseBranch, branch, name, remotes });
    const fetchUrl = git(draft, ["remote", "get-url", "origin"]);
    const remoteName = targets.length > 1 ? "one of origin's push addresses" : fetchUrl.ok && fetchUrl.out === targets[0]?.url ? "origin" : "origin's push address";
    /** @type {string[]} */
    const lines = [];
    if (scan.problems.length) lines.push(`What the branch would push cannot be checked: ${scan.problems.join("; ")}. Pass the right base with --base <branch>, or recreate the draft from its base branch.`);
    if (scan.unpushed.length) lines.push(unpushedText(scan.unpushed, remoteName, `Push the base branch to every push address of origin first (after checking those commits) or recreate the draft on the copy of the base they have, then rerun.`));
    if (scan.findings.length) {
      lines.push(`Possible secrets or personal details (${scan.findings.length}); remove each, or replace it with a placeholder such as <token>, user@example.com or ~/:`);
      for (const f of scan.findings.slice(0, 50)) lines.push(`  ${findingLine(f)}`);
      if (scan.findings.length > 50) lines.push(`  and ${scan.findings.length - 50} more`);
      if (scan.findings.some((f) => f.commit && !f.base)) lines.push(historyAdvice(scan.mergeBase));
    }
    if (scan.outside.length) lines.push(outsideText(scan.outside, name, scan.mergeBase));
    if (lines.length) fail(`the branch ${branch} cannot be published as it is. Nothing was pushed.\n  - ${lines.join("\n  - ")}\nFix the draft in ${draft}, have it reviewed and sealed again, then rerun.`);
    console.log("   ok");
  },
  true,
);

// 5. push
step("Push the branch", `git ls-remote <each push address of origin> refs/heads/${branch}; git -C ${sh(draft)} push --recurse-submodules=no --no-follow-tags -u origin ${branch}:${branch}`, () => {
  // Origin's branch may only be the checked head or behind it, at every address the push goes to: anything else holds
  // commits the seal never covered.
  for (const t of pushTargets()) {
    const remoteHead = t.refs.get(`refs/heads/${branch}`) ?? "";
    if (remoteHead && remoteHead !== localHead && !git(draft, ["merge-base", "--is-ancestor", remoteHead, localHead]).ok) {
      fail(`origin's ${branch} is at ${remoteHead.slice(0, 12)}, which is not the draft's head ${localHead.slice(0, 12)} or an ancestor of it: origin holds commits the seal never covered. Nothing was pushed. Look at origin's ${branch}; if those commits belong in the skill, bring them into the draft, have it reviewed and sealed again, then rerun; otherwise delete the remote branch by hand.`);
    }
  }
  // The remote and the refspec are named, so no push default, push remote or push refspec of origin changes where it
  // goes; submodules are never pushed with it, and no tag either (push.followTags would send the annotated tags that
  // point into the pushed commits, and tag messages are never scanned).
  const r = git(draft, ["push", "--recurse-submodules=no", "--no-follow-tags", "-u", "origin", `${branch}:${branch}`]);
  if (!r.ok) fail(`git push failed:\n${tail(r)}\nThe push never forces: if ${branch} exists on origin with other commits, look at it and resolve that by hand, then rerun.`);
  console.log("   ok");
});

// 6. pull request
let prUrl = "";
const body = () =>
  [
    `Skill: \`${name}\``,
    `Target: ${target} skills repository`,
    `Provenance digest: \`${String(provenance?.digest ?? "unknown")}\` (skills/${name}/provenance.json, ${String(provenance?.created_by ?? "claude-code-orchestration")})`,
    "",
    "This skill was created by an agent (a skill slice of claude-code-orchestration) and passed its skill gate and review.",
    "It needs a person's review before it is merged: read SKILL.md and its references, check the claims against their sources, and try it on a real task.",
  ].join("\n");
step("Open the pull request", `gh pr create --base ${baseBranch} --head ${branch} --title ${sh(`Add skill ${name}`)} --body <name, target, digest, created by an agent>`, () => {
  const existing = run("gh", ["pr", "view", branch, "--json", "url,state", "--jq", 'select(.state == "OPEN") | .url'], { cwd: draft });
  if (existing.ok && /^https?:\/\//.test(existing.out)) {
    prUrl = existing.out;
    console.log(`   an open pull request exists: ${prUrl}`);
    return;
  }
  const r = run("gh", ["pr", "create", "--base", baseBranch, "--head", branch, "--title", `Add skill ${name}`, "--body", body()], { cwd: draft });
  if (!r.ok) fail(`gh pr create failed:\n${tail(r)}\nCheck gh auth status and that ${baseBranch} exists on origin (or pass --base), then rerun: the push is already done and is not repeated harmfully.`);
  prUrl = r.out.split("\n").filter((l) => /^https?:\/\//.test(l)).pop() ?? r.out;
  console.log(`   ${prUrl}`);
});

if (!opt.merge) {
  if (!opt.dryRun) console.log(`\nPull request: ${prUrl}\nAfter review, merge it and install the skill with: npm run skill-publish -- ${name}${target === "public" ? " --target public" : ""} --merge`);
  process.exit(0);
}

// 7. merge
step("Merge the pull request", `gh pr merge <url> --merge --match-head-commit ${localHead || "<the checked head>"}`, () => {
  const r = run("gh", ["pr", "merge", prUrl, "--merge", "--match-head-commit", localHead], { cwd: mainCheckout });
  if (!r.ok) fail(`gh pr merge failed:\n${tail(r)}\nIf the pull request's head is no longer ${localHead.slice(0, 12)} (the commit that was checked), someone pushed to ${branch}: look at it before anything is merged. Otherwise merge ${prUrl} by hand (or fix what blocks it), then rerun with --merge.`);
  console.log("   ok");
});

// 8. fast-forward the main checkout
step("Fast-forward the main checkout", `git -C ${sh(mainCheckout)} pull --ff-only origin ${baseBranch}`, () => {
  const cur = git(mainCheckout, ["branch", "--show-current"]);
  if (cur.out !== baseBranch) fail(`the main checkout ${mainCheckout} is on ${cur.out || "no branch"}, not ${baseBranch}. Check out ${baseBranch} there, pull, and run the installer by hand.`);
  const r = git(mainCheckout, ["pull", "--ff-only", "origin", baseBranch]);
  if (!r.ok) fail(`the fast-forward failed:\n${tail(r)}\nThe pull request is merged. Bring ${mainCheckout} up to date by hand, then run its installer.`);
  console.log("   ok");
});

// 9. install
const installer = join(mainCheckout, "scripts", "install.sh");
const installShown = opt.install ? `sh -c ${sh(opt.install)}  (in ${mainCheckout})` : existsSync(installer) ? `bash scripts/install.sh --target claude  (in ${mainCheckout})` : "nothing: no --install and no scripts/install.sh";
step("Install the skill", installShown, () => {
  const r = opt.install
    ? run("sh", ["-c", opt.install], { cwd: mainCheckout, timeout: 600_000 })
    : existsSync(installer)
      ? run("bash", ["scripts/install.sh", "--target", "claude"], { cwd: mainCheckout, timeout: 600_000 })
      : null;
  if (r === null) {
    console.log(`   skipped: ${mainCheckout} has no scripts/install.sh. Install the skill your usual way, or pass --install "<command>".`);
    return;
  }
  if (!r.ok) fail(`the installer failed:\n${tail(r)}\nThe pull request is merged and the checkout is up to date: fix the install and run it by hand. The draft worktree is kept.`);
  console.log("   ok");
});

// 10. clean up
step("Remove the draft worktree", `git -C ${sh(mainCheckout)} worktree remove ${sh(draft)}; git branch -d ${branch}`, () => {
  const r = git(mainCheckout, ["worktree", "remove", draft]);
  if (!r.ok) fail(`git worktree remove failed:\n${tail(r)}\nThe skill is published; remove ${draft} by hand with git worktree remove.`);
  const d = git(mainCheckout, ["branch", "-d", branch]);
  console.log(d.ok ? "   ok" : `   worktree removed; the local branch ${branch} was kept (${d.err.split("\n")[0] ?? "git branch -d failed"})`);
});

if (!opt.dryRun) console.log(`\nPublished ${name}: ${prUrl}`);
