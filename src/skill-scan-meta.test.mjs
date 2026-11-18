// 2.0.0 (w6 item 1): the branch scan covers what a push carries besides lines and paths: commit messages, authors and
// committers, and the tags that point at the draft's commits. scanBranch is run on scratch repositories; the skill gate
// (hook) and `skill-publish --dry-run` (scratch bare remote, fake gh) are each run once on a refused and a clean draft.
// Nothing reaches a real remote and no model runs.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchRecord } from "../.claude/hooks/brief.mjs";
import { findingLine, MAX_TAG_CHAIN, objectFindings, scanBranch, scanText } from "../.claude/hooks/skill-scan.mjs";
import { seal } from "../.claude/hooks/skill-seal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "demo-skill";
const BRANCH = `skill/${NAME}`;
const ME = "t@example.invalid";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: ME, GIT_CONFIG_NOSYSTEM: "1" };
// Built at run time so this file holds no token-shaped literal.
const TOKEN = ["gh", "p_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("");
const HOMEPATH = ["", "home", "alice", "notes"].join("/");

/** @param {string} dir @param {string[]} args @param {string} home @param {Record<string, string>} [env] */
function git(dir, args, home, env = {}) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV, HOME: home, ...env } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A skills repository on main (with a validator and an origin) and a draft worktree on skill/<name> with one sealed commit. */
function setup(/** @type {{ message?: string, env?: Record<string, string> }} */ o = {}) {
  const base = mkdtempSync(join(tmpdir(), "skill-meta-"));
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
  git(repo, ["fetch", "-q", "origin"], base);
  const cfg = join(base, "config");
  const draft = join(cfg, "orchestration", "skill-drafts", "private", NAME);
  mkdirSync(dirname(draft), { recursive: true });
  git(repo, ["worktree", "add", "-q", "-b", BRANCH, draft, "main"], base);
  const sd = join(draft, "skills", NAME);
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, "SKILL.md"), `---\nname: ${NAME}\ndescription: Use when a demo is needed.\n---\n# Demo\n`);
  appendFileSync(join(draft, "README.md"), `| [${NAME}](skills/${NAME}/SKILL.md) | demo |\n`);
  seal(sd, { target: "private" });
  git(draft, ["add", "-A"], base);
  git(draft, ["commit", "-q", "-m", o.message ?? `add ${NAME}`], base, o.env);
  return { base, origin, repo, cfg, draft };
}

/** @param {(s: ReturnType<typeof setup>) => void} fn @param {Parameters<typeof setup>[0]} [o] */
function withSetup(fn, o) {
  const s = setup(o);
  try {
    fn(s);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
}

/** @param {ReturnType<typeof setup>} s @param {string[] | null} [identity] */
const scan = (s, identity = null) => scanBranch(s.draft, { base: "main", branch: BRANCH, name: NAME, identity });
/** @param {ReturnType<typeof scan>} r */
const meta = (r) => r.findings.filter((f) => f.where).map((f) => [f.where, f.line, f.kind]);

test("item 1: a token or a home path in a commit message is a finding with its line; a clean message is not", () => {
  withSetup(
    (s) => {
      const r = scan(s);
      assert.deepEqual(r.problems, []);
      assert.deepEqual(meta(r), [["message", 3, "GitHub token"], ["message", 4, "home-directory path"]]);
      const line = findingLine(/** @type {any} */ (r.findings.find((f) => f.where === "message")));
      assert.match(line, /^the message of commit [0-9a-f]{12} line 3: GitHub token$/);
      assert.ok(!JSON.stringify(r).includes(TOKEN), "the match is never kept");
    },
    { message: `add ${NAME}\n\nkey ${TOKEN}\nnotes in ${HOMEPATH}` },
  );
  // A no-reply trailer and the commit's own address pass; a third person's address does not.
  withSetup(
    (s) => assert.deepEqual(meta(scan(s)), [["message", 5, "e-mail address"]]),
    { message: `add ${NAME}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nSigned-off-by: t <${ME}>\nThanks to bob@corp-mail.com` },
  );
  withSetup((s) => assert.deepEqual(meta(scan(s)), []), { message: `add ${NAME}\n\nA clean body.` });
});

test("item 1: an author or committer name with a token is a finding; an identity address alone is not", () => {
  withSetup(
    (s) => {
      const r = scan(s);
      assert.deepEqual(meta(r), [["author", null, "GitHub token"]]);
      assert.match(findingLine(/** @type {any} */ (r.findings.find((f) => f.where))), /^the author line of commit [0-9a-f]{12}: GitHub token$/);
    },
    { env: { GIT_AUTHOR_NAME: `bot ${TOKEN}` } },
  );
  withSetup(
    (s) => {
      // A real address in the address field is no finding (every commit has one) ...
      assert.deepEqual(meta(scan(s)), []);
      // ... but for the publish step (identity given) an address the person's git does not use is listed.
      const r = scan(s, [ME]);
      assert.deepEqual(r.foreign.map((f) => [f.name, f.email]), [["Bob", "bob@corp-mail.com"]]);
      assert.deepEqual(scan(s, [ME, "bob@corp-mail.com"]).foreign, []);
      assert.equal(scan(s, []).foreign.length, 2, "no address configured: every identity is listed");
    },
    { env: { GIT_AUTHOR_NAME: "Bob", GIT_AUTHOR_EMAIL: "bob@corp-mail.com" } },
  );
});

test("item 1: a tag pointing at a draft commit is scanned (name, message); one on a base commit origin has is not", () => {
  withSetup((s) => {
    git(s.draft, ["tag", "-a", "v1", "-m", `release\n\nkey ${TOKEN}`], s.base);
    assert.deepEqual(meta(scan(s)), [["tag", null, "GitHub token"]]);
    git(s.draft, ["tag", "-d", "v1"], s.base);
    git(s.draft, ["tag", `x-${TOKEN}`], s.base); // a lightweight tag whose name is the secret
    const r = scan(s);
    assert.deepEqual(meta(r), [["tag", null, "GitHub token"]]);
    assert.ok(!findingLine(/** @type {any} */ (r.findings.find((f) => f.where))).includes(TOKEN), "the tag name is never shown");
    git(s.draft, ["tag", "-d", `x-${TOKEN}`], s.base);
    git(s.draft, ["tag", "-a", "v-clean", "-m", "a clean tag"], s.base);
    git(s.repo, ["tag", "-a", "v0", "-m", `old ${TOKEN}`, "main"], s.base);
    assert.deepEqual(meta(scan(s)), [], "a clean tag on the draft and a tag on the pushed base pass");
  });
});

// ---- the gate and the dry run, end to end ----

/** Run skill-gate.mjs as the hook on a stop of the skill slice's implementer. @param {ReturnType<typeof setup>} s */
function gate(s) {
  const dir = join(s.base, "project");
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["state.mjs", "brief.mjs", "run.mjs", "skill-seal.mjs", "skill-scan.mjs", "skill-gate.mjs", "builtin-agents.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  const brief = `SLICE: S9\nFILES: skills/${NAME}/SKILL.md, README.md\nDEPENDS: none\nKIND: skill\nSKILL: ${NAME}\n\nWrite the skill.`;
  writeFileSync(join(state, "journal-launches.jsonl"), `${JSON.stringify(launchRecord({ subagent_type: "implementer", prompt: brief }, { sessionId: "s1", agentId: "a1" }))}\n`);
  /** @type {Record<string, string | undefined>} */
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("ORCH_") || k.startsWith("CLAUDE_") || k.startsWith("GIT_")) delete e[k];
  Object.assign(e, { HOME: s.base, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: s.cfg, ORCH_SKILLS_REPO_PRIVATE: s.repo });
  const input = { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type: "implementer" };
  return spawnSync(process.execPath, [join(hooks, "skill-gate.mjs")], { input: JSON.stringify(input), env: e, encoding: "utf8", cwd: dir });
}

test("item 1: the skill gate refuses a draft whose commit message holds a token, and passes a clean one", () => {
  withSetup(
    (s) => {
      const r = gate(s);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /\[secrets\]/);
      assert.match(r.stderr, /the message of commit [0-9a-f]{12} line 3: GitHub token/);
      assert.match(r.stderr, /A finding in a commit message, author or committer is pushed with the commit/);
      assert.ok(!r.stderr.includes(TOKEN));
    },
    { message: `add ${NAME}\n\nkey ${TOKEN}` },
  );
  withSetup((s) => {
    const r = gate(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });
});

/** Run skill-publish.mjs with a fake gh. @param {ReturnType<typeof setup>} s @param {string[]} args @param {Record<string, string>} [env] */
function publish(s, args, env = {}) {
  const bin = join(s.base, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  /** @type {Record<string, string | undefined>} */
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("CLAUDE") || k.startsWith("GIT_") || k.startsWith("ORCH_")) delete e[k];
  Object.assign(e, GIT_ENV, { HOME: s.base, CLAUDE_CONFIG_DIR: s.cfg, PATH: `${bin}:${process.env.PATH}` }, env);
  return spawnSync(process.execPath, [join(root, "scripts", "skill-publish.mjs"), NAME, ...args], { env: e, encoding: "utf8", cwd: s.base });
}
/** @param {ReturnType<typeof setup>} s */
const pushed = (s) => spawnSync("git", ["-C", s.origin, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`]).status === 0;

test("item 1: skill-publish --dry-run refuses a token in a commit message, a foreign author and a tagged secret; a clean draft passes", () => {
  withSetup(
    (s) => {
      const r = publish(s, ["--dry-run"]);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /the message of commit [0-9a-f]{12} line 3: GitHub token/);
      assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN));
      assert.equal(pushed(s), false);
    },
    { message: `add ${NAME}\n\nkey ${TOKEN}` },
  );
  withSetup(
    (s) => {
      const r = publish(s, ["--dry-run"]);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /name authors or committers other than the address your git uses \(t@example\.invalid\): Bob <bob@corp-mail\.com> \(commit [0-9a-f]{12}\)/);
      // A git that uses that address (here as author, with t as committer) may publish it.
      assert.equal(publish(s, ["--dry-run"], { GIT_AUTHOR_EMAIL: "bob@corp-mail.com" }).status, 0);
    },
    { env: { GIT_AUTHOR_NAME: "Bob", GIT_AUTHOR_EMAIL: "bob@corp-mail.com" } },
  );
  withSetup((s) => {
    const clean = publish(s, ["--dry-run"]);
    assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
    git(s.draft, ["tag", "-a", "v1", "-m", `key ${TOKEN}`], s.base);
    const r = publish(s, ["--dry-run"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /a tag on commit [0-9a-f]{12} \(its name or its tag object\): GitHub token/);
    assert.equal(pushed(s), false);
  });
});

// ---- Review of attempt 1: every byte of a raw commit or tag object is scanned, but its fixed-form id lines. ----

/** git with stdin. @param {string} dir @param {string[]} args @param {string} input @param {string} home */
function gitIn(dir, args, input, home) {
  const r = spawnSync("git", ["-C", dir, ...args], { input, encoding: "utf8", env: { ...process.env, ...GIT_ENV, HOME: home } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
/** Replace the draft's head commit by a raw object made from it. @param {ReturnType<typeof setup>} s @param {(raw: string) => string} edit */
function rewriteHead(s, edit) {
  const raw = `${gitIn(s.draft, ["cat-file", "commit", "HEAD"], "", s.base)}\n`;
  const id = gitIn(s.draft, ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], edit(raw), s.base);
  git(s.draft, ["update-ref", `refs/heads/${BRANCH}`, id], s.base);
}
/** Put a raw tag object made from tag `name` back under that name. @param {ReturnType<typeof setup>} s @param {string} name @param {(raw: string) => string} edit */
function rewriteTag(s, name, edit) {
  const raw = `${gitIn(s.draft, ["cat-file", "tag", name], "", s.base)}\n`;
  const id = gitIn(s.draft, ["hash-object", "-t", "tag", "-w", "--literally", "--stdin"], edit(raw), s.base);
  git(s.draft, ["update-ref", `refs/tags/${name}`, id], s.base);
}
/** Insert header lines after the committer line. @param {string} raw @param {string} lines */
const afterCommitter = (raw, lines) => raw.replace(/^(committer [^\n]*\n)/m, `$1${lines}`);
/** Deterministic base64 armour lines, as a signature block holds them. @param {number} n @param {string} seed */
const armour = (n, seed) => {
  /** @type {string[]} */
  const out = [];
  let h = Buffer.from(seed);
  for (let i = 0; i < n; i++) {
    h = createHash("sha512").update(h).digest();
    out.push(Buffer.concat([h, createHash("sha256").update(h).digest()]).toString("base64").slice(0, 64));
  }
  return out;
};
/** An armoured signature block. @param {string} seed @param {string[]} [extra] */
const SIG = (seed, extra = []) => ["-----BEGIN PGP SIGNATURE-----", "", ...armour(6, seed), ...extra, "=AbCd", "-----END PGP SIGNATURE-----"];

test("gap 1: an encoding header holding a token is found (raw object and git -c i18n.commitEncoding)", () => {
  withSetup((s) => {
    rewriteHead(s, (raw) => afterCommitter(raw, `encoding ${TOKEN}\n`));
    assert.deepEqual(meta(scan(s)), [["header", null, "GitHub token"]]);
  });
  withSetup((s) => {
    writeFileSync(join(s.draft, "skills", NAME, "more.md"), "more\n");
    seal(join(s.draft, "skills", NAME), { target: "private" });
    git(s.draft, ["add", "-A"], s.base);
    git(s.draft, ["-c", `i18n.commitEncoding=${TOKEN}`, "commit", "-q", "-m", "more"], s.base);
    assert.deepEqual(meta(scan(s)), [["header", null, "GitHub token"]]);
  });
});

test("gap 2: a token on a continuation line of a gpgsig or gpgsig-sha256 block is found", () => {
  for (const key of ["gpgsig", "gpgsig-sha256"]) {
    withSetup((s) => {
      const [first, ...rest] = SIG(key, [`key ${TOKEN}`]);
      rewriteHead(s, (raw) => afterCommitter(raw, `${key} ${first}\n${rest.map((l) => ` ${l}\n`).join("")}`));
      assert.deepEqual(meta(scan(s)), [["header", null, "GitHub token"]], key);
    });
  }
});

test("gap 3: a token after the date or in a second <...> of an identity line is found; a second address is foreign", () => {
  withSetup((s) => {
    rewriteHead(s, (raw) => raw.replace(/^(author [^\n]*)$/m, `$1 ${TOKEN}`));
    assert.deepEqual(meta(scan(s)), [["author", null, "GitHub token"]]);
  });
  withSetup((s) => {
    rewriteHead(s, (raw) => raw.replace(/^(committer [^\n]*)$/m, "$1 <bob@corp-mail.com>"));
    const r = scan(s, [ME]);
    assert.deepEqual(meta(r), [["committer", null, "e-mail address"]]);
    assert.deepEqual(r.foreign.map((f) => f.email), ["bob@corp-mail.com"]);
    assert.match(findingLine(/** @type {any} */ (r.findings.find((f) => f.where))), /^the committer line of commit [0-9a-f]{12}: e-mail address$/);
  });
});

test("whole objects: an unknown header's continuation line, a tagger line after the date and a tag's signature are found", () => {
  withSetup((s) => {
    rewriteHead(s, (raw) => afterCommitter(raw, `x-note first line\n second ${HOMEPATH}\n`));
    assert.deepEqual(meta(scan(s)), [["header", null, "home-directory path"]]);
  });
  withSetup((s) => {
    git(s.draft, ["tag", "-a", "v1", "-m", "release"], s.base);
    rewriteTag(s, "v1", (raw) => raw.replace(/^(tagger [^\n]*)$/m, `$1 ${TOKEN}`));
    assert.deepEqual(meta(scan(s)), [["tag", null, "GitHub token"]]);
  });
  withSetup((s) => {
    git(s.draft, ["tag", "-a", "v1", "-m", "release"], s.base);
    rewriteTag(s, "v1", (raw) => `${raw}${SIG("tag", [`key ${TOKEN}`]).join("\n")}\n`);
    assert.deepEqual(meta(scan(s)), [["tag", null, "GitHub token"]]);
  });
});

test("whole objects: tree, parent, object and type lines are skipped only in their exact form", () => {
  const hex = "a".repeat(40);
  const at = { commit: "c".repeat(40) };
  const kinds = (/** @type {string} */ raw, /** @type {"commit" | "tag"} */ type) => objectFindings(raw, type, at).map((f) => [f.where, f.kind]);
  assert.deepEqual(kinds(`tree ${hex}\nparent ${hex}\nauthor t <${ME}> 1 +0000\ncommitter t <${ME}> 1 +0000\n\nok\n`, "commit"), []);
  assert.deepEqual(kinds(`tree ${hex} ${TOKEN}\nparent ${hex}\n\nok\n`, "commit"), [["header", "GitHub token"]]);
  assert.deepEqual(kinds(`tree ${hex}\nparent ${HOMEPATH}\n\nok\n`, "commit"), [["header", "home-directory path"]]);
  assert.deepEqual(kinds(`tree ${"b".repeat(64)}\nparent ${"b".repeat(64)}\n\nok\n`, "commit"), [], "SHA-256 ids");
  assert.deepEqual(kinds(`object ${hex}\ntype commit\ntag v1\ntagger t <${ME}> 1 +0000\n\nok\n`, "tag"), []);
  assert.deepEqual(kinds(`object ${hex}\ntype commit ${TOKEN}\n\nok\n`, "tag"), [["tag", "GitHub token"]]);
  assert.deepEqual(kinds(`object ${TOKEN}\ntype commit\n\nok\n`, "tag"), [["tag", "GitHub token"]]);
  // A latin1 byte or an encoding header changes nothing: every byte is read.
  assert.deepEqual(kinds(`tree ${hex}\nencoding ISO-8859-1\n\nZürich ${TOKEN}\n`, "commit"), [["message", "GitHub token"]]);
});

test("whole objects: a signed-looking commit with an armoured block and no secret passes; base64 armour never matches", () => {
  withSetup((s) => {
    const [first, ...rest] = SIG("clean");
    rewriteHead(s, (raw) => afterCommitter(raw, `gpgsig ${first}\n${rest.map((l) => ` ${l}\n`).join("")}`));
    const r = scan(s, [ME]);
    assert.deepEqual([meta(r), r.problems, r.foreign], [[], [], []]);
  });
  assert.deepEqual(scanText(armour(20000, "bulk").join("\n")), [], "20,000 armour lines: no pattern fires on plain base64");
});

// ---- Review of attempt 2: tag chains. A tag of a tag is followed to its final target, every tag object of the chain
// is scanned, a chain deeper than MAX_TAG_CHAIN or one with a missing or malformed object is a problem. A chain whose
// final target is a blob or a tree is scanned only when the push of the draft carries that object. ----

/** Write a tag object and return its id. @param {ReturnType<typeof setup>} s @param {string} object @param {string} type @param {string} msg @param {string} [tagName] */
const tagObject = (s, object, type, msg, tagName = "t") =>
  gitIn(s.draft, ["hash-object", "-t", "tag", "-w", "--stdin"], `object ${object}\ntype ${type}\ntag ${tagName}\ntagger t <${ME}> 1700000000 +0000\n\n${msg}\n`, s.base);
/** A chain of `n` tag objects over `target` (of `type`), innermost first; `msgs[i]` is the message of the i-th from the inside. Returns the outermost id. @param {ReturnType<typeof setup>} s @param {string} target @param {string} type @param {number} n @param {(i: number) => string} [msg] */
function chain(s, target, type, n, msg = () => "clean") {
  let id = target;
  let t = type;
  for (let i = 0; i < n; i++) {
    id = tagObject(s, id, t, msg(i), `l${i}`);
    t = "tag";
  }
  return id;
}
/** @param {ReturnType<typeof setup>} s */
const head = (s) => git(s.draft, ["rev-parse", `refs/heads/${BRANCH}`], s.base);

test("tag chains: a tag of a tag whose inner tag holds a token is found (two deep, only the outer ref exists)", () => {
  withSetup((s) => {
    const inner = tagObject(s, head(s), "commit", `key ${TOKEN}`, "inner");
    const outer = tagObject(s, inner, "tag", "clean", "outer");
    git(s.draft, ["update-ref", "refs/tags/outer", outer], s.base);
    const r = scan(s);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(meta(r), [["tag", null, "GitHub token"]]);
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  });
});

test("tag chains: a six-deep chain with the token in the innermost tag is found; a clean six-deep chain passes", () => {
  withSetup((s) => {
    git(s.draft, ["update-ref", "refs/tags/deep", chain(s, head(s), "commit", 6, (i) => (i === 0 ? `key ${TOKEN}` : "clean"))], s.base);
    const r = scan(s);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(meta(r), [["tag", null, "GitHub token"]]);
  });
  withSetup((s) => {
    git(s.draft, ["update-ref", "refs/tags/deep", chain(s, head(s), "commit", 6)], s.base);
    const r = scan(s);
    assert.deepEqual([r.problems, meta(r)], [[], []]);
  });
});

test("tag chains: a chain at the bound passes; one tag object deeper is a problem, never a silent stop", () => {
  withSetup((s) => {
    const max = chain(s, head(s), "commit", MAX_TAG_CHAIN);
    git(s.draft, ["update-ref", "refs/tags/max", max], s.base);
    assert.deepEqual(scan(s).problems, []);
    git(s.draft, ["update-ref", "refs/tags/over", tagObject(s, max, "tag", "clean")], s.base);
    const r = scan(s);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0] ?? "", new RegExp(`more than ${MAX_TAG_CHAIN} tag objects`));
  });
});

test("tag chains: a missing or malformed inner object is a problem", () => {
  withSetup((s) => {
    const outer = tagObject(s, "0123456789abcdef0123456789abcdef01234567", "tag", "clean");
    git(s.draft, ["update-ref", "refs/tags/dangling", outer], s.base);
    const r = scan(s);
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    assert.match(r.problems[0] ?? "", /tag/);
  });
  for (const bad of ["no object line at all\n", `object ${"a".repeat(39)}\ntype commit\n\nshort id\n`, `type commit\nobject ${"a".repeat(40)}\n\nwrong order\n`]) {
    withSetup((s) => {
      const inner = gitIn(s.draft, ["hash-object", "-t", "tag", "-w", "--literally", "--stdin"], bad, s.base);
      git(s.draft, ["update-ref", "refs/tags/bad", tagObject(s, inner, "tag", "clean")], s.base);
      const r = scan(s);
      assert.equal(r.problems.length, 1, `${JSON.stringify(bad)}: ${JSON.stringify(r.problems)}`);
    });
  }
  withSetup((s) => {
    // A `type` line that is not the named object's type (here `commit` over a tag object).
    const inner = tagObject(s, head(s), "commit", "clean");
    git(s.draft, ["update-ref", "refs/tags/mistyped", tagObject(s, inner, "commit", "clean")], s.base);
    const r = scan(s);
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    assert.match(r.problems[0] ?? "", /type/);
  });
});

test("tag chains: a blob or tree the draft adds is scanned like a commit; one outside the draft is ignored", () => {
  withSetup((s) => {
    const blob = git(s.draft, ["rev-parse", `${BRANCH}:skills/${NAME}/SKILL.md`], s.base);
    git(s.draft, ["update-ref", "refs/tags/b", chain(s, blob, "blob", 2, (i) => (i === 0 ? `key ${TOKEN}` : "clean"))], s.base);
    const r = scan(s);
    assert.deepEqual([r.problems, meta(r)], [[], [["tag", null, "GitHub token"]]]);
    assert.match(findingLine(/** @type {any} */ (r.findings.find((f) => f.where))), /^a tag on blob [0-9a-f]{12} \(its name or its tag object\): GitHub token$/);
  });
  withSetup((s) => {
    const tree = git(s.draft, ["rev-parse", `${BRANCH}^{tree}`], s.base);
    git(s.draft, ["update-ref", "refs/tags/t", chain(s, tree, "tree", 2, () => `key ${TOKEN}`)], s.base);
    assert.deepEqual(meta(scan(s)), [["tag", null, "GitHub token"]]);
    // A lightweight tag on a draft tree whose name is the secret.
    git(s.draft, ["update-ref", "refs/tags/t", "-d"], s.base);
    git(s.draft, ["tag", `x-${TOKEN}`, tree], s.base);
    assert.deepEqual(meta(scan(s)), [["tag", null, "GitHub token"]]);
  });
  withSetup((s) => {
    // Outside the draft: a loose blob nothing references, main's tree (the merge base has it), README.md's blob on main.
    const loose = gitIn(s.draft, ["hash-object", "-w", "--stdin"], `loose ${TOKEN}\n`, s.base);
    const mainTree = git(s.draft, ["rev-parse", "main^{tree}"], s.base);
    const mainBlob = git(s.draft, ["rev-parse", "main:README.md"], s.base);
    git(s.draft, ["update-ref", "refs/tags/loose", chain(s, loose, "blob", 2, () => `key ${TOKEN}`)], s.base);
    git(s.draft, ["update-ref", "refs/tags/maintree", chain(s, mainTree, "tree", 3, () => `key ${TOKEN}`)], s.base);
    git(s.draft, ["update-ref", "refs/tags/mainblob", tagObject(s, mainBlob, "blob", `key ${TOKEN}`)], s.base);
    git(s.draft, ["tag", `y-${TOKEN}`, loose], s.base);
    const r = scan(s);
    assert.deepEqual([r.problems, meta(r)], [[], []]);
  });
});
