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
