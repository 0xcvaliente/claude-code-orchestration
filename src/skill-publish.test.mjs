// scripts/skill-publish.mjs against local temporary git repositories: the skills repository's origin is a bare
// repository in a temp folder, the draft is a git worktree under a temporary CLAUDE_CONFIG_DIR, and `gh` is a fake on
// PATH that logs its arguments and answers like gh would. Nothing reaches a real remote and no model runs.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seal } from "../.claude/hooks/skill-seal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "skill-publish.mjs");
const NAME = "demo-skill";
const BRANCH = `skill/${NAME}`;
const PR_URL = "https://example.invalid/o/skills/pull/7";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };

/** @param {string} dir @param {string[]} args @param {string} home */
function git(dir, args, home) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV, HOME: home } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A skills repository on main with an origin, a sealed and committed draft on skill/<name>, and a fake gh.
 * `edit` changes the skill folder before the seal.
 * @param {{ edit?: (skillDir: string, draft: string) => void }} [o]
 */
function setup({ edit } = {}) {
  const base = mkdtempSync(join(tmpdir(), "skill-publish-"));
  const origin = join(base, "origin.git");
  const repo = join(base, "skills");
  git(base, ["init", "-q", "--bare", "-b", "main", origin], base);
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "scripts", "validate.py"), "print('ok')\n");
  writeFileSync(join(repo, "README.md"), "# Skills\n");
  git(repo, ["init", "-q", "-b", "main"], base);
  git(repo, ["add", "-A"], base);
  git(repo, ["commit", "-q", "-m", "init"], base);
  git(repo, ["remote", "add", "origin", origin], base);
  git(repo, ["push", "-q", "origin", "main"], base);
  const cfg = join(base, "config");
  const draft = join(cfg, "orchestration", "skill-drafts", "private", NAME);
  mkdirSync(dirname(draft), { recursive: true });
  git(repo, ["worktree", "add", "-q", "-b", BRANCH, draft, "main"], base);
  const sd = join(draft, "skills", NAME);
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, "SKILL.md"), `---\nname: ${NAME}\ndescription: A demo skill.\n---\n# Demo\n`);
  appendFileSync(join(draft, "README.md"), `| [${NAME}](skills/${NAME}/SKILL.md) | demo |\n`);
  edit?.(sd, draft);
  seal(sd, { target: "private" });
  git(draft, ["add", "-A"], base);
  git(draft, ["commit", "-q", "-m", `add ${NAME}`], base);
  // Fake gh: logs every call; `pr view` finds no pull request, `pr create` prints a URL, `pr merge` succeeds.
  const bin = join(base, "bin");
  mkdirSync(bin);
  const ghLog = join(base, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\ncase "$1 $2" in\n  "pr view") exit 1 ;;\n  "pr create") echo '${PR_URL}' ;;\n  "pr merge") exit 0 ;;\nesac\nexit 0\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return { base, origin, repo, cfg, draft, bin, ghLog };
}

/** @param {ReturnType<typeof setup>} s @param {string[]} args */
function publish(s, args) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE") || k.startsWith("GIT_") || k.startsWith("ORCH_")) delete env[k];
  Object.assign(env, GIT_ENV, { HOME: s.base, CLAUDE_CONFIG_DIR: s.cfg, PATH: `${s.bin}:${process.env.PATH}` });
  return spawnSync(process.execPath, [SCRIPT, NAME, ...args], { env, encoding: "utf8", cwd: s.base });
}

/** @param {ReturnType<typeof setup>} s */
const ghCalls = (s) => (existsSync(s.ghLog) ? readFileSync(s.ghLog, "utf8").split("\n").filter(Boolean) : []);

/** @param {(s: ReturnType<typeof setup>) => void} fn @param {Parameters<typeof setup>[0]} [o] */
function withSetup(fn, o) {
  const s = setup(o);
  try {
    fn(s);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
}

test("a sealed, committed draft is pushed, and the merge is pinned to the local head commit", () => {
  withSetup((s) => {
    const head = git(s.draft, ["rev-parse", "HEAD"], s.base);
    const r = publish(s, ["--merge"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(git(s.origin, ["rev-parse", `refs/heads/${BRANCH}`], s.base), head, "origin holds the local head");
    const merge = ghCalls(s).find((l) => l.startsWith("pr merge"));
    assert.equal(merge, `pr merge ${PR_URL} --merge --match-head-commit ${head}`);
  });
});

test("origin's skill branch with commits the draft lacks is refused before the push, and gh is never called", () => {
  withSetup((s) => {
    const head = git(s.draft, ["rev-parse", "HEAD"], s.base);
    // Someone else pushes a commit on top of the draft's head to origin's skill branch.
    git(s.draft, ["push", "-q", "origin", `${BRANCH}:${BRANCH}`], s.base);
    const other = join(s.base, "other");
    git(s.base, ["clone", "-q", "-b", BRANCH, s.origin, other], s.base);
    writeFileSync(join(other, "skills", NAME, "extra.md"), "not sealed\n");
    git(other, ["add", "-A"], s.base);
    git(other, ["commit", "-q", "-m", "unsealed"], s.base);
    git(other, ["push", "-q", "origin", BRANCH], s.base);
    const remote = git(s.origin, ["rev-parse", `refs/heads/${BRANCH}`], s.base);
    assert.notEqual(remote, head);
    const r = publish(s, ["--merge"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /origin's skill\/demo-skill is at [0-9a-f]{12}, which is not the draft's head [0-9a-f]{12} or an ancestor of it/);
    assert.deepEqual(ghCalls(s), [], "no pull request is opened, reused or merged");
    assert.equal(git(s.origin, ["rev-parse", `refs/heads/${BRANCH}`], s.base), remote, "origin unchanged");
  });
});

test("origin's skill branch at an ancestor of the draft's head is fast-forwarded as before", () => {
  withSetup((s) => {
    git(s.draft, ["push", "-q", "origin", `${BRANCH}:${BRANCH}`], s.base);
    writeFileSync(join(s.draft, "skills", NAME, "SKILL.md"), `---\nname: ${NAME}\ndescription: A demo skill, v2.\n---\n# Demo\n`);
    seal(join(s.draft, "skills", NAME), { target: "private" });
    git(s.draft, ["commit", "-q", "-am", "v2"], s.base);
    const head = git(s.draft, ["rev-parse", "HEAD"], s.base);
    const r = publish(s, []);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(git(s.origin, ["rev-parse", `refs/heads/${BRANCH}`], s.base), head);
  });
});

test("a sealed file that is ignored, so never committed, stops the publish at the git check and is named", () => {
  withSetup(
    (s) => {
      assert.equal(git(s.draft, ["status", "--porcelain"], s.base), "", "git status is clean");
      const r = publish(s, ["--merge"]);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /not committed on skill\/demo-skill/);
      assert.match(r.stderr, /skills\/demo-skill\/notes\.md/);
      assert.deepEqual(ghCalls(s), []);
      assert.equal(spawnSync("git", ["-C", s.origin, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`]).status, 1, "nothing pushed");
    },
    {
      edit: (sd, draft) => {
        writeFileSync(join(draft, ".gitignore"), `skills/${NAME}/notes.md\n`);
        writeFileSync(join(sd, "notes.md"), "on disk only\n");
      },
    },
  );
});

// ---- W-1 (audit 2026-11-16): the same branch scan and path check as the skill gate, before anything is pushed and in
// the dry run too.

// Built at run time so this file holds no token-shaped literal.
const TOKEN = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

/** Seal the skill again and commit everything in the draft. @param {ReturnType<typeof setup>} s @param {string} msg */
function commitAll(s, msg) {
  seal(join(s.draft, "skills", NAME), { target: "private" });
  git(s.draft, ["add", "-A"], s.base);
  git(s.draft, ["commit", "-q", "-m", msg], s.base);
}

/** The publish was refused at the branch scan: exit 1, nothing pushed, gh never called. @param {ReturnType<typeof setup>} s @param {string[]} args */
function refused(s, args) {
  const r = publish(s, args);
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /the branch skill\/demo-skill cannot be published as it is/);
  assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN), "no matched text in the output");
  assert.deepEqual(ghCalls(s), []);
  assert.equal(spawnSync("git", ["-C", s.origin, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`]).status, 1, "nothing pushed");
  return r.stderr;
}

test("W-1: a token added and then removed in a later commit stops the dry run and the publish before the push", () => {
  withSetup(
    (s) => {
      rmSync(join(s.draft, "skills", NAME, "notes.md"));
      commitAll(s, "remove the token");
      for (const args of [["--dry-run"], ["--merge"]]) {
        const msg = refused(s, args);
        assert.match(msg, /skills\/demo-skill\/notes\.md, only in earlier commit [0-9a-f]{12}: GitHub token/);
        assert.match(msg, /Recreate the branch's commits without it/);
      }
    },
    { edit: (sd) => writeFileSync(join(sd, "notes.md"), `token ${TOKEN}\n`) },
  );
});

test("W-1: a token in a file outside the skill folder stops the dry run, naming the file and the path", () => {
  withSetup(
    (s) => {
      const msg = refused(s, ["--dry-run"]);
      assert.match(msg, /notes\/leak\.md line 1: GitHub token/);
      assert.match(msg, /The branch changes paths outside skills\/demo-skill\/ and README\.md: notes\/leak\.md\./);
    },
    { edit: (_sd, draft) => { mkdirSync(join(draft, "notes")); writeFileSync(join(draft, "notes", "leak.md"), `token ${TOKEN}\n`); } },
  );
});

test("W-1: an extra file outside the allowed paths with no secret stops the publish for the path alone", () => {
  withSetup(
    (s) => {
      const msg = refused(s, ["--merge"]);
      assert.match(msg, /outside skills\/demo-skill\/ and README\.md: plan\.txt\./);
      assert.doesNotMatch(msg, /GitHub token|e-mail|home-directory/);
    },
    { edit: (_sd, draft) => writeFileSync(join(draft, "plan.txt"), "A plan with nothing secret.\n") },
  );
});

test("W-1 retry: a draft made from a local base commit that origin lacks is refused, naming that commit", () => {
  for (const viaBase of [false, true]) {
    const s = setup();
    try {
      // Rebuild the draft on a local commit with a token that origin never got (on main, or on a branch passed as --base).
      git(s.repo, ["worktree", "remove", "--force", s.draft], s.base);
      git(s.repo, ["branch", "-q", "-D", BRANCH], s.base);
      if (viaBase) git(s.repo, ["checkout", "-q", "-b", "local-base"], s.base);
      writeFileSync(join(s.repo, "notes.txt"), `token ${TOKEN}\n`);
      git(s.repo, ["add", "-A"], s.base);
      git(s.repo, ["commit", "-q", "-m", "local only"], s.base);
      const leak = git(s.repo, ["rev-parse", "HEAD"], s.base);
      if (viaBase) git(s.repo, ["checkout", "-q", "main"], s.base);
      git(s.repo, ["worktree", "add", "-q", "-b", BRANCH, s.draft, viaBase ? "local-base" : "main"], s.base);
      const sd = join(s.draft, "skills", NAME);
      mkdirSync(sd, { recursive: true });
      writeFileSync(join(sd, "SKILL.md"), `---\nname: ${NAME}\ndescription: A demo skill.\n---\n# Demo\n`);
      commitAll(s, "skill");
      const msg = refused(s, viaBase ? ["--dry-run", "--base", "local-base"] : ["--dry-run"]);
      assert.match(msg, new RegExp(`notes\\.txt, in commit ${leak.slice(0, 12)}, which is not part of the draft: GitHub token`));
      assert.match(msg, new RegExp(`1 commit of the base that origin lacks \\(${leak.slice(0, 12)}\\)`));
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  }
});

test("W-1: a clean branch passes the scan in the dry run, which still pushes nothing", () => {
  withSetup((s) => {
    const r = publish(s, ["--dry-run"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Scan the branch for secrets and paths outside the skill\n {3}ok/);
    assert.deepEqual(ghCalls(s), []);
    assert.equal(spawnSync("git", ["-C", s.origin, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`]).status, 1, "nothing pushed");
  });
});

// ---- W-1 third attempt: the scan compares with what every push address of origin has (git remote get-url --push
// --all), not with origin's fetch address. Dry runs only; every remote is a scratch bare repository.

/**
 * Rebuild the draft on a new commit of main that holds a token and is on origin's fetch address (as on a remote whose
 * push address differs). Returns that commit's id.
 * @param {ReturnType<typeof setup>} s
 */
function draftOnTokenBase(s) {
  git(s.repo, ["worktree", "remove", "--force", s.draft], s.base);
  git(s.repo, ["branch", "-q", "-D", BRANCH], s.base);
  writeFileSync(join(s.repo, "notes.txt"), `token ${TOKEN}\n`);
  git(s.repo, ["add", "-A"], s.base);
  git(s.repo, ["commit", "-q", "-m", "base with a token"], s.base);
  const leak = git(s.repo, ["rev-parse", "HEAD"], s.base);
  git(s.repo, ["push", "-q", "origin", "main"], s.base);
  git(s.repo, ["worktree", "add", "-q", "-b", BRANCH, s.draft, "main"], s.base);
  const sd = join(s.draft, "skills", NAME);
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, "SKILL.md"), `---\nname: ${NAME}\ndescription: A demo skill.\n---\n# Demo\n`);
  commitAll(s, "skill");
  return leak;
}

/** A new empty bare repository next to origin. @param {ReturnType<typeof setup>} s @param {string} n */
function bare(s, n) {
  const p = join(s.base, `${n}.git`);
  git(s.base, ["init", "-q", "--bare", "-b", "main", p], s.base);
  return p;
}

/**
 * A draft on a token commit that origin's fetch address has; `configure` then sets where origin pushes.
 * @param {(s: ReturnType<typeof setup>) => void} configure @param {(s: ReturnType<typeof setup>, leak: string) => void} fn
 */
function withTokenBase(configure, fn) {
  const s = setup();
  try {
    const leak = draftOnTokenBase(s);
    configure(s);
    fn(s, leak);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
}

/** The dry run named the base commit as unscanned and pushed with the branch. @param {string} msg @param {string} leak */
function namesLeak(msg, leak) {
  // The empty push address lacks the first commit too, so the base commits named are that one and the token's.
  assert.match(msg, new RegExp(`2 commits of the base that (one of )?origin's push address(es)? lacks \\(${leak.slice(0, 12)}, [0-9a-f]{12}\\)`));
  assert.match(msg, new RegExp(`notes\\.txt, in commit ${leak.slice(0, 12)}, which is not part of the draft: GitHub token`));
}

test("W-1 push address: a push URL that lacks the base commit the fetch URL has is refused, naming that commit", () => {
  withTokenBase(
    (s) => git(s.repo, ["config", "remote.origin.pushurl", bare(s, "push")], s.base),
    (s, leak) => namesLeak(refused(s, ["--dry-run"]), leak),
  );
});

test("W-1 push address: the same through a url.<base>.pushInsteadOf rewrite", () => {
  withTokenBase(
    (s) => git(s.repo, ["config", `url.${bare(s, "push")}.pushInsteadOf`, s.origin], s.base),
    (s, leak) => namesLeak(refused(s, ["--dry-run"]), leak),
  );
});

test("W-1 push address: two push URLs of which one lacks the base commit are refused", () => {
  withTokenBase(
    (s) => {
      git(s.repo, ["config", "remote.origin.pushurl", s.origin], s.base);
      git(s.repo, ["config", "--add", "remote.origin.pushurl", bare(s, "second")], s.base);
    },
    (s, leak) => namesLeak(refused(s, ["--dry-run"]), leak),
  );
});

test("W-1 push address: a push URL that cannot be read is refused, saying so", () => {
  withSetup((s) => {
    git(s.repo, ["config", "remote.origin.pushurl", join(s.base, "missing.git")], s.base);
    const r = publish(s, ["--dry-run"]);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /cannot read origin's push address/);
    assert.match(r.stderr, /Nothing was pushed/);
    assert.doesNotMatch(r.stdout, /Scan the branch for secrets and paths outside the skill\n {3}ok/);
  });
});

test("W-1 push address: origin set up as a mirror is refused, since its push would not be the one checked", () => {
  withSetup((s) => {
    git(s.repo, ["config", "remote.origin.mirror", "true"], s.base);
    const r = publish(s, ["--dry-run"]);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /remote\.origin\.mirror/);
  });
});

test("W-1 push address: a push URL that is the fetch URL, and an origin with none, both pass with an up-to-date base", () => {
  for (const same of [true, false]) {
    withSetup((s) => {
      if (same) git(s.repo, ["config", "remote.origin.pushurl", s.origin], s.base);
      const r = publish(s, ["--dry-run"]);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /Scan the branch for secrets and paths outside the skill\n {3}ok/);
      assert.deepEqual(ghCalls(s), []);
    });
  }
});

// fix-guards-2 item 3: with push.followTags set, a plain push also sends the annotated tags that point into the pushed
// commits, and tag messages are never scanned. The publish push names --no-follow-tags, and the dry run says so.
// Dry run only; the printed push options are tried against scratch bare remotes of their own, never origin.
test("guards-2 item 3: the push never follows tags, even with push.followTags set, and the dry run reports it", () => {
  withSetup((s) => {
    git(s.repo, ["config", "push.followTags", "true"], s.base);
    git(s.draft, ["tag", "-a", "v-demo", "-m", "a tag message the scan never reads"], s.base);
    const r = publish(s, ["--dry-run"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const shown = /would run: .*?; git -C \S+ push (.*?) -u origin (\S+)$/m.exec(r.stdout);
    assert.ok(shown, `the dry run shows the push:\n${r.stdout}`);
    const opts = String(shown[1]).split(" ");
    const refspec = String(shown[2]);
    assert.ok(opts.includes("--no-follow-tags"), `the push names --no-follow-tags: ${shown[0]}`);
    const tagAt = (/** @type {string} */ remote) => spawnSync("git", ["-C", remote, "rev-parse", "--verify", "--quiet", "refs/tags/v-demo"]).status === 0;
    assert.equal(tagAt(s.origin), false, "nothing pushed");
    assert.deepEqual(ghCalls(s), []);
    // The options as shown keep the tag back; without --no-follow-tags git sends it (the setting is live here).
    const shownRemote = bare(s, "shown");
    git(s.draft, ["push", "-q", ...opts, shownRemote, refspec], s.base);
    assert.equal(tagAt(shownRemote), false, "the shown push sent no tag");
    const plainRemote = bare(s, "plain");
    git(s.draft, ["push", "-q", ...opts.filter((o) => o !== "--no-follow-tags"), plainRemote, refspec], s.base);
    assert.equal(tagAt(plainRemote), true, "control: push.followTags sends the tag without the option");
  });
});
