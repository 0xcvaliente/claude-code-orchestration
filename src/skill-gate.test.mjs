// skill-gate.mjs (SubagentStop, deny-only) run as a hook in a throwaway project. The skills repository is a temporary
// git repository with a fake scripts/validate.py (it fails when README.md has no row linking skills/<name>), the draft
// worktree is created the way plan-check's facts block says (git worktree add -b skill/<name> <draft> <base>) under a
// temporary CLAUDE_CONFIG_DIR, and launch records are written with brief.mjs's launchRecord, as journal.mjs writes
// them. HOME, CLAUDE_CONFIG_DIR and the state dir are temp folders: nothing touches the real ~/.claude or skills repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchRecord } from "../.claude/hooks/brief.mjs";
import { seal } from "../.claude/hooks/skill-seal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = ["state.mjs", "brief.mjs", "run.mjs", "skill-seal.mjs", "skill-gate.mjs"];
const NAME = "demo-skill";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };
// Built at run time so this file holds no token-shaped literal.
const TOKEN = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
const VALIDATOR = `import os, re, sys
name = os.path.basename(sys.argv[1].rstrip("/"))
if not os.path.isfile(os.path.join(sys.argv[1], "SKILL.md")):
    print("no SKILL.md"); sys.exit(1)
if ("](skills/%s" % name) not in open("README.md").read():
    print("README.md has no catalog row for skills/%s" % name); sys.exit(1)
print("ok")
`;

/** @param {string} dir @param {string[]} args @param {string} home */
function git(dir, args, home) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV, HOME: home } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A project with the hooks, a skills repo on main, and a config dir. `inBase` puts the complete skill into the base
 * branch already (so the draft branch has no commit of its own).
 */
function setup() {
  const base = mkdtempSync(join(tmpdir(), "skill-gate-"));
  const dir = join(base, "project");
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  for (const h of HOOKS) copyFileSync(join(root, ".claude", "hooks", h), join(dir, ".claude", "hooks", h));
  const repo = join(base, "private-skills");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "scripts", "validate.py"), VALIDATOR);
  writeFileSync(join(repo, "README.md"), "# Skills\n\n| Skill | What |\n| --- | --- |\n");
  git(repo, ["init", "-q", "-b", "main"], base);
  git(repo, ["add", "-A"], base);
  git(repo, ["commit", "-q", "-m", "init"], base);
  const cfg = join(base, "config");
  const draft = join(cfg, "orchestration", "skill-drafts", "private", NAME);
  return { base, dir, repo, cfg, draft, state: join(dir, ".claude", "state") };
}

/** @param {ReturnType<typeof setup>} s */
const worktree = (s) => {
  mkdirSync(dirname(s.draft), { recursive: true });
  git(s.repo, ["worktree", "add", "-q", "-b", `skill/${NAME}`, s.draft, "main"], s.base);
};

/**
 * Write a complete skill into the draft (or `at`), let `edit` change it, seal it and commit it.
 * @param {ReturnType<typeof setup>} s
 * @param {{ edit?: (skillDir: string, wt: string) => void, after?: (skillDir: string, wt: string) => void, commit?: boolean, at?: string }} [o]
 */
function writeSkill(s, { edit, after, commit = true, at } = {}) {
  const wt = at ?? s.draft;
  const sd = join(wt, "skills", NAME);
  mkdirSync(join(sd, "references"), { recursive: true });
  writeFileSync(join(sd, "SKILL.md"), `---\nname: ${NAME}\ndescription: >-\n  Use when a demo is needed. Works on the demo\n  data only.\n---\n# Demo\n\nSee references/a.md.\n`);
  writeFileSync(join(sd, "references", "a.md"), "Reference text. Example address: user@example.com, path ~/notes.\n");
  appendFileSync(join(wt, "README.md"), `| [${NAME}](skills/${NAME}/SKILL.md) | A demo skill. |\n`);
  edit?.(sd, wt);
  seal(sd);
  after?.(sd, wt);
  if (commit) {
    git(wt, ["add", "-A"], s.base);
    git(wt, ["commit", "-q", "-m", `add ${NAME}`], s.base);
  }
  return sd;
}

const BRIEF = `SLICE: S9\nFILES: skills/${NAME}/SKILL.md, README.md\nDEPENDS: none\nKIND: skill\nSKILL: ${NAME}\n\nWrite the skill.`;
/** Append a launch record as journal.mjs writes it. @param {ReturnType<typeof setup>} s @param {string} prompt @param {{ agentId?: string, type?: string }} [o] */
function launch(s, prompt = BRIEF, { agentId = "a1", type = "implementer" } = {}) {
  mkdirSync(s.state, { recursive: true });
  appendFileSync(join(s.state, "journal-launches.jsonl"), `${JSON.stringify(launchRecord({ subagent_type: type, prompt }, { sessionId: "s1", agentId }))}\n`);
}

/** Run the gate. @param {ReturnType<typeof setup>} s @param {unknown} input @param {Record<string, string>} [env] */
function stop(s, input = { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type: "implementer" }, env = {}) {
  /** @type {Record<string, string | undefined>} */
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("ORCH_") || k.startsWith("CLAUDE_") || k.startsWith("GIT_")) delete e[k];
  Object.assign(e, { HOME: s.base, CLAUDE_PROJECT_DIR: s.dir, CLAUDE_CONFIG_DIR: s.cfg }, env);
  return spawnSync(process.execPath, [join(s.dir, ".claude", "hooks", "skill-gate.mjs")], { input: typeof input === "string" ? input : JSON.stringify(input), env: e, encoding: "utf8", cwd: s.dir });
}
/** @param {ReturnType<typeof setup>} s @returns {any[]} */
const records = (s) => (existsSync(join(s.state, "skill-gate.jsonl")) ? readFileSync(join(s.state, "skill-gate.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** @param {(s: ReturnType<typeof setup>) => void} fn */
function withSetup(fn) {
  const s = setup();
  try {
    fn(s);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
}

/** One failing run: exit 2, exactly `codes` failed, the record says so. @param {ReturnType<typeof setup>} s @param {string[]} codes */
function blocked(s, codes) {
  const r = stop(s);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  const rec = records(s).at(-1);
  assert.deepEqual([rec.decision, rec.reason, rec.failed], ["block", "checks_failed", codes]);
  for (const c of codes) assert.match(r.stderr, new RegExp(`\\[${c}\\]`));
  assert.doesNotMatch(r.stderr, /ORCH_|CLAUDE_PLUGIN_OPTION_|skill_create|skills_repo/, "the message names no switch");
  return r.stderr;
}

test("a complete, sealed, committed draft passes with no output and one allow record", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s);
    launch(s);
    const r = stop(s);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    const recs = records(s);
    assert.equal(recs.length, 1);
    const { ts, ...rest } = recs[0];
    assert.ok(ts);
    assert.deepEqual(rest, { session_id: "s1", agent_id: "a1", agent_type: "implementer", slice: "S9", skill: NAME, target: "private", decision: "allow", reason: "ok", failed: [], problems: 0 });
  });
});

test("a: SKILL.md name, description and length each fail as skill_md", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (sd) => writeFileSync(join(sd, "SKILL.md"), `---\nname: other-name\ndescription: "${"d".repeat(1025)}"\n---\n${"line\n".repeat(501)}`) });
    launch(s);
    const msg = blocked(s, ["skill_md"]);
    assert.match(msg, /frontmatter name must be demo-skill/);
    assert.match(msg, /description has 1025 characters; it needs 1 to 1024/);
    assert.match(msg, /it has 50\d lines/);
  });
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (sd) => rmSync(join(sd, "SKILL.md")) });
    launch(s);
    // The fake validator fails too without SKILL.md: both are listed.
    const msg = blocked(s, ["skill_md", "validator"]);
    assert.match(msg, /SKILL\.md is missing/);
  });
});

test("b: a failing validator is listed with its output; a missing python3 has its own text", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (_sd, wt) => writeFileSync(join(wt, "README.md"), "# Skills\n") });
    launch(s);
    const msg = blocked(s, ["validator"]);
    assert.match(msg, /python3 scripts\/validate\.py skills\/demo-skill exited 1/);
    assert.match(msg, /README\.md has no catalog row for skills\/demo-skill/);
  });
  withSetup((s) => {
    worktree(s);
    writeSkill(s);
    launch(s);
    // A PATH that has git but no python3.
    const bin = join(s.base, "bin");
    mkdirSync(bin);
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const r = stop(s, undefined, { PATH: bin });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /\[validator\] python3 is not available/);
    assert.deepEqual(records(s).at(-1).failed, ["validator"]);
  });
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (_sd, wt) => appendFileSync(join(wt, "scripts", "validate.py"), "# relaxed\n") });
    launch(s);
    assert.match(blocked(s, ["validator"]), /The branch adds or changes files under scripts\//);
  });
});

test("c: secrets and personal details are named by file, line and kind, never echoed", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, {
      edit: (sd, wt) => {
        writeFileSync(join(sd, "references", "a.md"), `Intro\nUse ${TOKEN} here.\nWrite to jane.doe@corp-mail.org.\nSee /home/jane/notes and /root/x.\n`);
        appendFileSync(join(wt, "README.md"), "Contact: jane.doe@corp-mail.org\n");
      },
    });
    launch(s);
    const msg = blocked(s, ["secrets"]);
    assert.match(msg, /skills\/demo-skill\/references\/a\.md line 2: GitHub token/);
    assert.match(msg, /skills\/demo-skill\/references\/a\.md line 3: e-mail address/);
    assert.match(msg, /skills\/demo-skill\/references\/a\.md line 4: home-directory path/);
    assert.match(msg, /README\.md line 6: e-mail address/);
    assert.ok(!msg.includes(TOKEN) && !msg.includes("jane") && !msg.includes("corp-mail"), "no matched text in the message");
    const log = readFileSync(join(s.state, "skill-gate.jsonl"), "utf8");
    assert.ok(!log.includes(TOKEN) && !log.includes("jane"), "no matched text in the log");
  });
  withSetup((s) => {
    worktree(s);
    // A private key block and cloud keys, each its own kind; the validator output is masked too.
    const key = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
    const aws = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    writeSkill(s, { edit: (sd) => writeFileSync(join(sd, "references", "a.md"), `${key}\nkey ${aws}\n`) });
    launch(s);
    const msg = blocked(s, ["secrets"]);
    assert.match(msg, /line 1: private key block/);
    assert.match(msg, /line 2: AWS access key/);
    assert.ok(!msg.includes(aws));
  });
});

test("d: a file changed after the seal fails as seal", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { after: (sd) => appendFileSync(join(sd, "references", "a.md"), "more\n") });
    launch(s);
    assert.match(blocked(s, ["seal"]), /references\/a\.md changed after the seal/);
  });
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { after: (sd) => rmSync(join(sd, "provenance.json")) });
    launch(s);
    assert.match(blocked(s, ["seal"]), /provenance\.json is missing/);
  });
});

test("e: an unclean worktree, or a branch with no commit of its own, fails as git_state", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { after: (_sd, wt) => writeFileSync(join(wt, "notes.txt"), "scratch\n"), commit: true });
    writeFileSync(join(s.draft, "notes2.txt"), "uncommitted\n");
    launch(s);
    assert.match(blocked(s, ["git_state"]), /1 uncommitted paths/);
  });
  withSetup((s) => {
    // The skill is already on the base branch: the draft branch adds nothing.
    writeSkill(s, { at: s.repo });
    worktree(s);
    launch(s);
    assert.match(blocked(s, ["git_state"]), /branch skill\/demo-skill has no commit that main lacks/);
  });
});

test("several failures are listed together in one message", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (sd) => writeFileSync(join(sd, "SKILL.md"), `---\nname: wrong\ndescription: x\n---\n`), after: (sd) => appendFileSync(join(sd, "SKILL.md"), "late\n"), commit: false });
    launch(s);
    const msg = blocked(s, ["skill_md", "seal", "git_state"]);
    assert.match(msg, /not ready \(3 problems\)/);
    assert.match(msg, /^1\. \[skill_md\]/m);
    assert.match(msg, /^2\. \[seal\]/m);
    assert.match(msg, /^3\. \[git_state\]/m);
  });
});

test("a missing draft worktree is one failure that points to the brief's command", () => {
  withSetup((s) => {
    launch(s);
    const msg = blocked(s, ["draft_missing"]);
    assert.match(msg, /does not exist\. Create it with the worktree command from your brief/);
  });
});

test("loop guard: three blocks, then the stop goes through with skill_gate_gave_up", () => {
  withSetup((s) => {
    launch(s);
    for (let i = 1; i <= 3; i++) {
      assert.equal(stop(s).status, 2);
      assert.equal(records(s).at(-1).blocks, i);
    }
    const r = stop(s);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    const last = records(s).at(-1);
    assert.deepEqual([last.decision, last.reason, last.failed], ["allow", "skill_gate_gave_up", ["draft_missing"]]);
    // Another agent of the slice has its own count.
    launch(s, BRIEF, { agentId: "a2" });
    assert.equal(stop(s, { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a2", agent_type: "implementer" }).status, 2);
  });
});

test("the plugin's implementer is gated; another plugin's implementer, a reviewer and a plain implementer are not", () => {
  withSetup((s) => {
    launch(s);
    assert.equal(stop(s, { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type: "orchestration:implementer" }).status, 2);
  });
  withSetup((s) => {
    launch(s); // a skill launch record exists for a1, but the stop is not ours
    for (const agent_type of ["other-plugin:implementer", "reviewer", "orchestration:reviewer", "researcher", "", "implementer2"]) {
      const r = stop(s, { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type });
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], agent_type);
    }
    // A plain implementer brief (no KIND: skill), and a skill brief from another session.
    launch(s, "SLICE: S1\nFILES: src/a.ts\nDEPENDS: none\n", { agentId: "a3" });
    for (const input of [
      { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a3", agent_type: "implementer" },
      { hook_event_name: "SubagentStop", session_id: "other", agent_id: "a1", agent_type: "implementer" },
      { hook_event_name: "SubagentStop", session_id: "s1", agent_type: "implementer" },
    ]) {
      const r = stop(s, input);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], JSON.stringify(input));
    }
    assert.equal(existsSync(join(s.state, "skill-gate.jsonl")), false, "no record");
  });
  withSetup((s) => {
    // KIND: skill with an invalid name is not a skill slice for the gate.
    launch(s, "SLICE: S9\nFILES: README.md\nDEPENDS: none\nKIND: skill\nSKILL: Bad_Name\n");
    assert.deepEqual(stop(s).status, 0);
    assert.equal(existsSync(join(s.state, "skill-gate.jsonl")), false);
  });
});

test("a stop before its launch record reads the brief from the transcript", () => {
  withSetup((s) => {
    const transcript = join(s.base, "t.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: BRIEF } })}\n`);
    const r = stop(s, { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a9", agent_type: "implementer", agent_transcript_path: transcript });
    assert.equal(r.status, 2);
    assert.deepEqual(records(s).at(-1).failed, ["draft_missing"]);
  });
});

test("malformed input exits 0 with no output and no record", () => {
  withSetup((s) => {
    launch(s);
    for (const input of ["not json", "", "[]", "null", "42", JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", agent_id: "a1", agent_type: "implementer" })]) {
      const r = stop(s, input);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], input);
    }
    assert.equal(existsSync(join(s.state, "skill-gate.jsonl")), false);
  });
});

// ---- Retry fixes: the six reviewer gaps.

/** Every entry under `dir` with its type, size, mtime and content hash (links by target, never followed). @param {string} dir */
function tree(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    for (const n of readdirSync(abs).sort()) {
      const a = join(abs, n);
      const r = `${rel}/${n}`;
      const st = lstatSync(a);
      if (st.isSymbolicLink()) out.push(`${r} -> ${readlinkSync(a)}`);
      else if (st.isDirectory()) {
        out.push(`${r}/ ${st.mtimeMs}`);
        walk(a, r);
      } else out.push(`${r} ${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(a)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return out;
}

test("gap 1: a branch cannot steer the validator through scripts/, the current folder or PYTHON* variables", () => {
  // A module the validator imports, added under scripts/ and committed: refused before python runs.
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (_sd, wt) => { writeFileSync(join(wt, "README.md"), "# none\n"); writeFileSync(join(wt, "scripts", "re.py"), "import sys\nsys.exit(0)\n"); } });
    launch(s);
    const msg = blocked(s, ["validator"]);
    assert.match(msg, /adds or changes files under scripts\//);
    assert.equal(records(s).at(-1).decision, "block");
  });
  // The same file untracked and ignored (git status stays clean): still refused.
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (_sd, wt) => writeFileSync(join(wt, ".gitignore"), "scripts/re.py\n") });
    writeFileSync(join(s.draft, "scripts", "re.py"), "import sys\nsys.exit(0)\n");
    launch(s);
    assert.match(blocked(s, ["validator"]), /adds or changes files under scripts\//);
  });
  // A shadowing module at the worktree root, and one on PYTHONPATH: isolated python ignores both, so the real
  // validator runs and reports the missing catalog row.
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (_sd, wt) => { writeFileSync(join(wt, "README.md"), "# none\n"); writeFileSync(join(wt, "re.py"), "import sys\nsys.exit(0)\n"); } });
    const shadow = join(s.base, "shadow");
    mkdirSync(shadow);
    writeFileSync(join(shadow, "re.py"), "import sys\nsys.exit(0)\n");
    writeFileSync(join(shadow, "sitecustomize.py"), "import sys\nsys.exit(0)\n");
    launch(s);
    const r = stop(s, undefined, { PYTHONPATH: shadow, PYTHONSTARTUP: join(shadow, "re.py"), PYTHONUSERBASE: shadow });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /validate\.py skills\/demo-skill exited 1/);
    assert.match(r.stderr, /README\.md has no catalog row/);
  });
});

test("gap 2: a gate run leaves the draft worktree and the repository byte for byte unchanged", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s);
    launch(s);
    const before = [tree(s.draft), tree(s.repo)];
    assert.equal(stop(s).status, 0);
    assert.deepEqual([tree(s.draft), tree(s.repo)], before, "passing run");
    writeFileSync(join(s.draft, "README.md"), "# none\n");
    git(s.draft, ["commit", "-q", "-am", "drop row"], s.base);
    const before2 = [tree(s.draft), tree(s.repo)];
    assert.equal(stop(s).status, 2);
    assert.deepEqual([tree(s.draft), tree(s.repo)], before2, "failing run");
    assert.equal(existsSync(join(s.draft, "scripts", "__pycache__")), false, "no bytecode");
  });
});

test("gap 3: a skill folder that is a link to a sealed folder elsewhere fails as skill_dir", () => {
  withSetup((s) => {
    worktree(s);
    const out = join(s.base, "outside", NAME);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "SKILL.md"), `---\nname: ${NAME}\ndescription: x\n---\n`);
    seal(out);
    mkdirSync(join(s.draft, "skills"), { recursive: true });
    symlinkSync(out, join(s.draft, "skills", NAME));
    appendFileSync(join(s.draft, "README.md"), `| [${NAME}](skills/${NAME}/SKILL.md) | d |\n`);
    git(s.draft, ["add", "-A"], s.base);
    git(s.draft, ["commit", "-q", "-m", "add"], s.base);
    launch(s);
    assert.match(blocked(s, ["skill_dir"]), /skills\/demo-skill is a link/);
  });
  withSetup((s) => {
    // skills/ itself a link: the folder resolves outside the draft.
    worktree(s);
    const out = join(s.base, "outside");
    writeSkill(s, { at: out, commit: false });
    symlinkSync(join(out, "skills"), join(s.draft, "skills"));
    appendFileSync(join(s.draft, "README.md"), `| [${NAME}](skills/${NAME}/SKILL.md) | d |\n`);
    git(s.draft, ["add", "-A"], s.base);
    git(s.draft, ["commit", "-q", "-m", "add"], s.base);
    launch(s);
    assert.match(blocked(s, ["skill_dir"]), /resolves to a place outside the draft worktree/);
  });
});

test("gap 4: a file with NUL bytes is scanned, and a file too large to scan is a finding", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (sd) => writeFileSync(join(sd, "references", "notes.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`\nkey=${TOKEN}\n`)])) });
    launch(s);
    const msg = blocked(s, ["secrets"]);
    assert.match(msg, /references\/notes\.bin line 2: GitHub token/);
    assert.ok(!msg.includes(TOKEN));
  });
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (sd) => writeFileSync(join(sd, "references", "big.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)) });
    launch(s);
    assert.match(blocked(s, ["secrets"]), /references\/big\.txt: too large to scan \(5242881 bytes/);
  });
});

test("gap 5: reserved names excuse an address only as example.com/.org/.net or a reserved final label", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (sd) => writeFileSync(join(sd, "references", "a.md"), "ok: user@example.com a@docs.example.org b@x.example.net c@host.test d@x.invalid e@box.localhost f@y.example git@github.com:o/r\nbad: bob@test.acme.com\nbad: carol@example.com.evil.no\nbad: dan@invalid.acme.io\n") });
    launch(s);
    const msg = blocked(s, ["secrets"]);
    assert.match(msg, /a\.md line 2: e-mail address/);
    assert.match(msg, /a\.md line 3: e-mail address/);
    assert.match(msg, /a\.md line 4: e-mail address/);
    assert.doesNotMatch(msg, /a\.md line 1:/, "the reserved forms pass");
    assert.ok(!msg.includes("acme") && !msg.includes("bob"));
  });
});

test("gap 6: a home-directory path after a URL scheme is found", () => {
  withSetup((s) => {
    worktree(s);
    writeSkill(s, { edit: (sd) => writeFileSync(join(sd, "references", "a.md"), "open file:///home/alice/notes\nand file:///Users/bob/x and file:///root/y\nfine: https://example.com/home/page and ~/notes\n") });
    launch(s);
    const msg = blocked(s, ["secrets"]);
    assert.match(msg, /a\.md line 1: home-directory path/);
    assert.match(msg, /a\.md line 2: home-directory path/);
    assert.doesNotMatch(msg, /a\.md line 3:/);
    assert.ok(!msg.includes("alice"));
  });
});
