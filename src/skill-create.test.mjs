// Skill slices in plan-check.mjs (KIND: skill, SKILL, TARGET, UPDATE, DRAFTS) and the DRAFT reply line in journal.mjs,
// run as hooks in a throwaway project. The skills repositories are temporary git repositories, the config dir
// (CLAUDE_CONFIG_DIR, which holds the draft home) is a temp folder and installed skills come from a temp
// ORCH_SKILL_ROOTS: nothing here touches the real skills repositories or the real ~/.claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchRecord, parseHeader, parsePlan, parseReply, stopRecord } from "../.claude/hooks/brief.mjs";
import { HINT_INTRO } from "../.claude/hooks/skill-hint.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs", "file-profile.mjs", "skill-catalog.mjs", "skill-hint.mjs", "journal.mjs"];
const temp = (/** @type {string} */ p) => mkdtempSync(join(tmpdir(), p));
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };
/** @param {string} dir @param {string[]} args */
function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV, HOME: dir } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A fake skills repository: a git work tree on `branch` with scripts/validate.py, README.md and the given skills.
 * @param {string} dir @param {{ branch?: string, skills?: string[], validator?: boolean, init?: boolean }} [o]
 */
function skillsRepo(dir, { branch = "main", skills = [], validator = true, init = true } = {}) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  if (validator) writeFileSync(join(dir, "scripts", "validate.py"), "print('ok')\n");
  writeFileSync(join(dir, "README.md"), "# Skills\n");
  for (const s of skills) {
    mkdirSync(join(dir, "skills", s), { recursive: true });
    writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: x\n---\n`);
  }
  if (init) {
    git(dir, ["init", "-q", "-b", branch]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "init"]);
  }
  return dir;
}

/**
 * A throwaway project with the hooks, two skills repositories, a config dir and an installed-skills root. `reviewed`
 * writes a plan reviewer's stop (an older journal's record) so the plan-review gate is open with no run.
 */
function setup({ reviewed = true } = {}) {
  const base = temp("skill-create-");
  const dir = join(base, "project");
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  for (const h of HOOKS) copyFileSync(join(root, ".claude", "hooks", h), join(dir, ".claude", "hooks", h));
  const priv = skillsRepo(join(base, "private-skills"), { skills: ["existing-private"] });
  const pub = skillsRepo(join(base, "public-skills"), { branch: "trunk", skills: ["existing-public"] });
  const cfg = join(base, "config");
  mkdirSync(cfg, { recursive: true });
  const installed = join(base, "installed");
  mkdirSync(join(installed, "installed-skill"), { recursive: true });
  writeFileSync(join(installed, "installed-skill", "SKILL.md"), "---\nname: installed-skill\ndescription: An installed skill.\n---\n");
  mkdirSync(join(installed, "tdd"), { recursive: true });
  writeFileSync(join(installed, "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Test-driven development.\n---\n");
  if (reviewed) {
    mkdirSync(join(dir, ".claude", "state"), { recursive: true });
    writeFileSync(join(dir, ".claude", "state", "journal.jsonl"), `${JSON.stringify({ ts: "t", session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" })}\n`);
  }
  return { base, dir, priv, pub, cfg, installed };
}

const CLEAR = ["ORCH_SKILL_HINTS", "ORCH_SKILL_ROOTS", "ORCH_READ_ROUTER", "ORCH_ALLOW_BUILTINS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_PLUGIN_ROOT", "ORCH_STALL_GATE", "ORCH_ALLOW_HAIKU", "ORCH_SKILL_CREATE", "ORCH_SKILLS_REPO_PRIVATE", "ORCH_SKILLS_REPO_PUBLIC", "ORCH_ESCALATION", "ORCH_RUN_STALE_MIN"];
/** The environment of a hook run in `s`: both repos configured, hints off, unless `env` says otherwise. @param {ReturnType<typeof setup>} s @param {Record<string, string | undefined>} env */
function envOf(s, env = {}) {
  /** @type {Record<string, string | undefined>} */
  const e = { ...process.env };
  for (const k of CLEAR) delete e[k];
  for (const k of Object.keys(e)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_") || k.startsWith("GIT_")) delete e[k];
  // HOME is the temp base too, so no fallback path can reach the real ~/.claude.
  Object.assign(e, { HOME: s.base, CLAUDE_PROJECT_DIR: s.dir, CLAUDE_CONFIG_DIR: s.cfg, ORCH_SKILL_ROOTS: s.installed, ORCH_SKILL_HINTS: "off", ORCH_SKILLS_REPO_PRIVATE: s.priv, ORCH_SKILLS_REPO_PUBLIC: s.pub }, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
  return e;
}
/** @param {ReturnType<typeof setup>} s @param {string} script @param {unknown} payload @param {Record<string, string | undefined>} [env] */
const hook = (s, script, payload, env = {}) =>
  spawnSync(process.execPath, [join(s.dir, ".claude", "hooks", script)], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env: /** @type {NodeJS.ProcessEnv} */ (envOf(s, env)), encoding: "utf8" });
/** @param {ReturnType<typeof setup>} s @param {string} prompt @param {Record<string, string | undefined>} [env] @param {string} [type] @param {Record<string, unknown>} [more] */
const launch = (s, prompt, env = {}, type = "implementer", more = {}) => hook(s, "plan-check.mjs", { session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: type, prompt, ...more } }, env);
/** @param {ReturnType<typeof setup>} s @param {string} name @returns {any[]} */
const logOf = (s, name) => {
  const f = join(s.dir, ".claude", "state", name);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** @param {{ stdout: string }} r */
const out = (r) => JSON.parse(r.stdout).hookSpecificOutput;
/** @param {string} name @param {string} [more] */
const skillBrief = (name, more = "") => `SLICE: ${name}-slice\nFILES: skills/${name}/, README.md\nDEPENDS: none\nKIND: skill\nSKILL: ${name}${more}\n\nWrite the skill.`;

// ---------------------------------------------------------------------------------------------------- parser

test("parser: SKILL, TARGET, UPDATE and DRAFTS on a brief, KIND/SKILL/TARGET on a planned slice, DRAFT on a reply", () => {
  const h = parseHeader("SLICE: s\nFILES: skills/a/\nKIND: Skill\nSKILL: `release-notes`\nTARGET: PUBLIC.\nUPDATE: yes\nDRAFTS: a, b-c, Bad, a");
  assert.deepEqual([h.kind, h.skill, h.target, h.update, h.drafts], ["skill", "release-notes", "public", true, ["a", "b-c"]]);
  for (const bad of ["Release", "a_b", "-a", "a-", "a--b", "a b", "x".repeat(65)]) assert.equal(parseHeader(`SKILL: ${bad}`).skill, bad === "a b" ? "a" : null, bad);
  assert.equal(parseHeader(`SKILL: ${"x".repeat(64)}`).skill, "x".repeat(64));
  assert.equal(parseHeader("SKILLS: tdd").skill, null, "SKILLS is another line");
  assert.equal(parseHeader("TARGET: shared").target, null);
  assert.equal(parseHeader("UPDATE: no").update, false);
  const p = parsePlan("PLAN REVIEW\nSLICE: k\nKIND: skill\nSKILL: my-skill\nTARGET: public\nFILES: skills/my-skill/\nSLICE: j\nFILES: a.py\nTARGET: private");
  assert.deepEqual(p.slices.map((x) => [x.slice, x.kind, x.skill, x.target]), [["k", "skill", "my-skill", "public"], ["j", null, null, "private"]]);
  assert.deepEqual(parseReply("STATUS: pass\nDRAFT: my-skill skill/my-skill").draft, { name: "my-skill", branch: "skill/my-skill" });
  for (const bad of ["DRAFT: my-skill", "DRAFT: my-skill skill/x extra", "DRAFT: My skill/x", "DRAFT: a skill/../x", "> DRAFT: a skill/a", "DRAFT: a -b", "DRAFTS: a skill/a"]) assert.equal(parseReply(bad).draft, null, bad);
});

test("records: launch and stop records carry the new fields only when the lines are there (C5)", () => {
  const plain = launchRecord({ subagent_type: "implementer", prompt: "SLICE: a\nFILES: a.py\nDEPENDS: none" }, { ts: "t", sessionId: "s" });
  for (const k of ["skill", "target", "update", "drafts"]) assert.equal(k in plain, false, k);
  const skill = launchRecord({ subagent_type: "implementer", prompt: `${skillBrief("my-skill")}\nTARGET: public\nUPDATE: yes\nDRAFTS: other-one` }, { ts: "t", sessionId: "s" });
  assert.deepEqual([skill.kind, skill.skill, skill.target, skill.update, skill.drafts], ["skill", "my-skill", "public", true, ["other-one"]]);
  const before = stopRecord({ ts: "t", sessionId: "s", role: "implementer", slice: "a", reply: "STATUS: pass\nOPEN: none" });
  assert.equal("draft" in before, false);
  const after = stopRecord({ ts: "t", sessionId: "s", role: "implementer", slice: "a", reply: "Secret reply text.\nSTATUS: pass\nDRAFT: my-skill skill/my-skill\nOPEN: none" });
  assert.deepEqual(after.draft, { name: "my-skill", branch: "skill/my-skill" });
  assert.ok(!JSON.stringify(after).includes("Secret"));
});

test("journal: a reply's DRAFT line is kept as name and branch; a reply without one is journaled as before", () => {
  const s = setup();
  try {
    const stop = (/** @type {string} */ id, /** @type {string} */ reply) => hook(s, "journal.mjs", { hook_event_name: "SubagentStop", session_id: "s1", agent_type: "implementer", agent_id: id, last_assistant_message: reply });
    for (const [i, prompt] of [["a1", skillBrief("my-skill")], ["a2", "SLICE: plain\nFILES: a.py\nDEPENDS: none"]]) {
      const r = hook(s, "journal.mjs", { hook_event_name: "PostToolUse", session_id: "s1", tool_input: { subagent_type: "implementer", prompt }, tool_response: { agentId: `${i}xxxxx` } });
      assert.equal(r.status, 0);
    }
    assert.equal(stop("a1xxxxx", "Done, secret words.\nSTATUS: pass\nDRAFT: my-skill skill/my-skill\nOPEN: none").status, 0);
    assert.equal(stop("a2xxxxx", "STATUS: pass\nOPEN: none").status, 0);
    const stops = logOf(s, "journal.jsonl").filter((e) => e.slice !== "plan");
    assert.deepEqual(stops.map((e) => [e.slice, e.draft ?? null]), [["my-skill-slice", { name: "my-skill", branch: "skill/my-skill" }], ["plain", null]]);
    assert.equal("draft" in /** @type {any} */ (stops[1]), false);
    assert.deepEqual(Object.keys(/** @type {any} */ (stops[1])).sort(), ["agent_id", "answers", "gaps", "open", "quotes", "role", "run", "session_id", "slice", "status", "ts"]);
    assert.ok(!readFileSync(join(s.dir, ".claude", "state", "journal.jsonl"), "utf8").includes("secret words"));
    const launches = logOf(s, "journal-launches.jsonl");
    assert.equal(launches[0].skill, "my-skill");
    assert.equal("skill" in launches[1], false);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------- allow and facts

test("a skill slice goes to the private repo by default; facts name every path and command, and the command works", () => {
  const s = setup();
  try {
    const brief = skillBrief("release-notes");
    const r = launch(s, brief, {}, "implementer", { description: "d" });
    assert.equal(r.status, 0, r.stderr);
    const o = out(r);
    assert.equal(o.permissionDecision, "allow");
    assert.equal(o.updatedInput.description, "d");
    const draft = join(s.cfg, "orchestration", "skill-drafts", "private", "release-notes");
    const facts = [
      "",
      "",
      "Skill draft (added by the plan check; every value below comes from the hook, use it as given):",
      `- Repository: the private skills repository at ${s.priv}`,
      `- Draft worktree: ${draft}`,
      "- Branch skill/release-notes, based on main",
      `- Create the draft worktree first: git -C ${s.priv} worktree add -b skill/release-notes ${draft} main`,
      "- The paths on this brief's FILES line are relative to the draft worktree, not to the project.",
      "- Validator, run in the draft worktree: python3 scripts/validate.py skills/release-notes",
      "- Catalog file: README.md in the draft worktree (one row for the skill)",
      `- Seal, after the last change: node ${join(s.dir, ".claude", "hooks", "skill-seal.mjs")} ${join(draft, "skills", "release-notes")}`,
      "- Authoring skill: load skill-authoring with the Skill tool before starting",
    ].join("\n");
    assert.equal(o.updatedInput.prompt, `${brief}${facts}`);
    const pc = logOf(s, "plan-check.jsonl");
    assert.deepEqual(pc.map((e) => [e.decision, e.reason]), [["allow", "ok"]]);
    assert.deepEqual(pc[0].files, [join(draft, "skills", "release-notes"), join(draft, "README.md")], "FILES resolve against the draft worktree");
    const rec = logOf(s, "skill-create.jsonl");
    assert.equal(rec.length, 1);
    const { ts, base_sha: baseSha, ...fields } = rec[0];
    assert.match(String(baseSha), /^[0-9a-f]{40,64}$/, "the base commit is pinned for the skill gate");
    assert.deepEqual(fields, {
      session_id: "s1", decision: "allow", reason: "ok", skill: "release-notes", target: "private", update: false, repo: s.priv, draft, branch: "skill/release-notes",
      base: "main", worktree: "new", facts: "appended", slice: "release-notes-slice", files: pc[0].files, agent_type: "implementer", run: "none-0",
    });
    assert.ok(!JSON.stringify(rec).includes("Write the skill"), "never brief text");
    // The command in the facts creates the worktree as said; a retry is told to reuse it.
    const cmd = spawnSync("git", ["-C", s.priv, "worktree", "add", "-b", "skill/release-notes", draft, "main"], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    assert.equal(cmd.status, 0, cmd.stderr);
    assert.equal(git(draft, ["branch", "--show-current"]), "skill/release-notes");
    const again = out(launch(s, brief));
    assert.match(again.updatedInput.prompt, /\n- The draft worktree exists already \(an earlier attempt\): work in it and do not create it again\.\n/);
    assert.ok(!again.updatedInput.prompt.includes("worktree add"));
    assert.deepEqual(logOf(s, "skill-create.jsonl").map((e) => e.worktree), ["new", "exists"]);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("TARGET: public uses the public repo (C9: only when the brief says so); without a public repo it is blocked", () => {
  const s = setup();
  try {
    const o = out(launch(s, skillBrief("pub-skill", "\nTARGET: public")));
    const draft = join(s.cfg, "orchestration", "skill-drafts", "public", "pub-skill");
    assert.ok(o.updatedInput.prompt.includes(`- Repository: the public skills repository at ${s.pub}\n`));
    assert.ok(o.updatedInput.prompt.includes(`worktree add -b skill/pub-skill ${draft} trunk`), "the base is the repo's current branch");
    assert.deepEqual(logOf(s, "skill-create.jsonl").map((e) => e.target), ["public"]);
    // No public repo configured: a public skill is blocked, a private one is not affected.
    const t = setup();
    try {
      const r = launch(t, skillBrief("pub-two", "\nTARGET: public"), { ORCH_SKILLS_REPO_PUBLIC: undefined });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /public skills repository is not set up/);
      const priv = launch(t, skillBrief("priv-two", "\nTARGET: nonsense"), { ORCH_SKILLS_REPO_PUBLIC: undefined });
      assert.equal(priv.status, 0, "a private skill does not need the public repo");
      assert.ok(out(priv).updatedInput.prompt.includes("the private skills repository"), "an unknown TARGET stays private");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("the plugin's hook copy names orchestration:skill-authoring", () => {
  const s = setup();
  try {
    const r = spawnSync(process.execPath, [join(s.dir, ".claude", "hooks", "plan-check.mjs"), "--plugin"], {
      input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "orchestration:implementer", prompt: `${skillBrief("plug-skill")}\nPATH: light` } }),
      // The plugin copy keeps its state in the plugin data dir: a temp one here, never the real ~/.claude.
      env: /** @type {NodeJS.ProcessEnv} */ (envOf(s, { CLAUDE_PLUGIN_DATA: join(s.base, "plugin-data") })),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(out(r).updatedInput.prompt, /\n- Authoring skill: load orchestration:skill-authoring with the Skill tool before starting$/);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("facts travel in the same updatedInput as the skill hints and the haiku rule's model raise", () => {
  const s = setup();
  try {
    mkdirSync(join(s.dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(s.dir, ".claude", "agents", "implementer.md"), "---\nname: implementer\nmodel: haiku\n---\nbody\n");
    const brief = skillBrief("hinted-skill", "\nSKILLS: tdd");
    const r = launch(s, brief, { ORCH_SKILL_HINTS: "on" });
    assert.equal(r.status, 0, r.stderr);
    const o = out(r);
    assert.equal(o.updatedInput.model, "sonnet", "the haiku rule's raise");
    const p = String(o.updatedInput.prompt);
    assert.ok(p.startsWith(`${brief}\n\n${HINT_INTRO}\n- tdd (explicit)\n\nSkill draft (added by the plan check;`), p);
    assert.ok(p.endsWith("- Authoring skill: load skill-authoring with the Skill tool before starting"));
    assert.equal(r.stdout.split("hookSpecificOutput").length, 2, "one output object");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("a facts block with a line that parses as a brief line is dropped and logged", () => {
  const s = setup();
  try {
    const cfg = join(s.base, "cfg\nSLICE: evil");
    mkdirSync(cfg, { recursive: true });
    const r = launch(s, skillBrief("odd-skill"), { CLAUDE_CONFIG_DIR: cfg });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "nothing to append: no allow is printed");
    assert.equal(logOf(s, "skill-create.jsonl")[0].facts, "dropped");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------- blocks

/**
 * Three launches of one brief: two blocks with `reason`, then an allow that gave up.
 * @param {ReturnType<typeof setup>} s @param {string} brief @param {string} reason @param {RegExp} message @param {Record<string, string | undefined>} [env]
 */
function blocksTwice(s, brief, reason, message, env = {}) {
  for (let i = 0; i < 2; i++) {
    const r = launch(s, brief, env);
    assert.equal(r.status, 2, `${reason} block ${i + 1}: ${r.stderr}`);
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stderr, /ORCH_|CLAUDE_PLUGIN_OPTION_|skill_create\b|skills_repo/, "C1: no switch in a block message");
    assert.equal(r.stdout, "");
  }
  const r = launch(s, brief, env);
  assert.equal(r.status, 0, `${reason} gives up: ${r.stderr}`);
  const pc = logOf(s, "plan-check.jsonl").filter((e) => e.slice === parseHeader(brief).slice);
  assert.deepEqual(pc.map((e) => e.reason), [reason, reason, `${reason}_gave_up`]);
  const sc = logOf(s, "skill-create.jsonl").filter((e) => e.slice === parseHeader(brief).slice);
  assert.deepEqual(sc.map((e) => [e.decision, e.reason]), [["block", reason], ["block", reason], ["allow", `${reason}_gave_up`]]);
  return r;
}

test("skill_create_off: blocked twice, then through without facts", () => {
  const s = setup();
  try {
    const r = blocksTwice(s, skillBrief("off-skill"), "skill_create_off", /creating skills is turned off/, { ORCH_SKILL_CREATE: "OFF" });
    assert.equal(r.stdout, "", "no facts after giving up on an off switch");
    // The plugin option reaches the hook through state.mjs's bridge.
    const t = setup();
    try {
      assert.equal(launch(t, skillBrief("off-two"), { CLAUDE_PLUGIN_OPTION_SKILL_CREATE: "off" }).status, 2);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("skill_name_invalid: no SKILL line, or a name that breaks the rule", () => {
  const s = setup();
  try {
    blocksTwice(s, "SLICE: nameless\nFILES: skills/x/\nDEPENDS: none\nKIND: skill", "skill_name_invalid", /needs a line SKILL: <name>/);
    const r = launch(s, "SLICE: badname\nFILES: skills/x/\nDEPENDS: none\nKIND: skill\nSKILL: Bad_Name");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /skill_name_invalid|needs a line SKILL/);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("skill_repo_missing: not configured, a relative path, not a git work tree, or no scripts/validate.py", () => {
  const cases = /** @type {[string, (s: ReturnType<typeof setup>) => Record<string, string | undefined>][]} */ ([
    ["unset", () => ({ ORCH_SKILLS_REPO_PRIVATE: undefined })],
    ["relative", () => ({ ORCH_SKILLS_REPO_PRIVATE: "private-skills" })],
    ["no-git", (s) => ({ ORCH_SKILLS_REPO_PRIVATE: skillsRepo(join(s.base, "plain"), { init: false }) })],
    ["no-validator", (s) => ({ ORCH_SKILLS_REPO_PRIVATE: skillsRepo(join(s.base, "novalid"), { validator: false }) })],
  ]);
  for (const [label, env] of cases) {
    const s = setup();
    try {
      const r = blocksTwice(s, skillBrief(`repo-${label}`), "skill_repo_missing", /private skills repository is not set up/, env(s));
      assert.equal(r.stdout, "", `${label}: no facts without a repo`);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  }
});

test("skill_exists: a folder in either repo or an installed skill; UPDATE: yes lets it through", () => {
  const s = setup();
  try {
    blocksTwice(s, skillBrief("existing-public"), "skill_exists", /a skill named existing-public already exists/);
    const r = launch(s, skillBrief("installed-skill"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /installed-skill already exists/);
    const upd = launch(s, skillBrief("existing-private", "\nUPDATE: yes"));
    assert.equal(upd.status, 0, upd.stderr);
    assert.match(out(upd).updatedInput.prompt, /worktree add -b skill\/existing-private /);
    assert.equal(logOf(s, "skill-create.jsonl").at(-1).update, true);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("skill_limit: a second new skill with another name in the same run; the same skill again and UPDATE slices pass", () => {
  const s = setup();
  try {
    assert.equal(launch(s, skillBrief("first-skill")).status, 0);
    assert.equal(launch(s, skillBrief("first-skill")).status, 0, "a retry of the same skill");
    assert.equal(launch(s, skillBrief("existing-private", "\nUPDATE: yes")).status, 0, "an update is not a new skill");
    const r = blocksTwice(s, skillBrief("second-skill"), "skill_limit", /already creates the skill first-skill.*DRAFTS: first-skill/);
    assert.match(out(r).updatedInput.prompt, /skill\/second-skill/, "after giving up the slice still gets its facts");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------- FILES and the plan

/** A planned, reviewed run in session s1 from `plan` (journal records: the PLAN REVIEW launch and its reviewer's stop). @param {ReturnType<typeof setup>} s @param {string} plan */
function planned(s, plan) {
  const state = join(s.dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  const now = Date.now();
  const rec = launchRecord({ subagent_type: "reviewer", prompt: plan }, { ts: new Date(now - 2000).toISOString(), sessionId: "s1", agentId: "plan1" });
  writeFileSync(join(state, "journal-launches.jsonl"), `${JSON.stringify(rec)}\n`);
  writeFileSync(join(state, "journal.jsonl"), `${JSON.stringify({ ts: new Date(now - 1000).toISOString(), session_id: "s1", agent_id: "plan1", role: "reviewer", slice: "plan", status: "pass", answers: {}, open: [] })}\n`);
}
const PLAN = [
  "PLAN REVIEW",
  "SLICE: notes-skill",
  "KIND: skill",
  "SKILL: release-notes",
  "FILES: skills/release-notes/, README.md",
  "DEPENDS: none",
  "GOAL: the skill",
  "SLICE: readme",
  "FILES: README.md, docs/",
  "DEPENDS: none",
  "GOAL: the project's README",
].join("\n");

test("FILES of a skill slice resolve against its draft worktree in the launch and the plan: README.md never collides with the project's", () => {
  for (const order of [["notes-skill", "readme"], ["readme", "notes-skill"]]) {
    const s = setup({ reviewed: false });
    try {
      planned(s, PLAN);
      const briefs = /** @type {Record<string, string>} */ ({
        "notes-skill": "SLICE: notes-skill\nFILES: skills/release-notes/SKILL.md, README.md\nDEPENDS: none\nKIND: skill\nSKILL: release-notes",
        readme: "SLICE: readme\nFILES: README.md\nDEPENDS: none",
      });
      for (const id of order) {
        const r = launch(s, /** @type {string} */ (briefs[id]));
        assert.equal(r.status, 0, `${order.join(">")}: ${id}: ${r.stderr}`);
      }
      const pc = logOf(s, "plan-check.jsonl");
      assert.deepEqual(pc.map((e) => [e.slice, e.reason]), order.map((id) => [id, "ok"]));
      const draft = join(s.cfg, "orchestration", "skill-drafts", "private", "release-notes");
      assert.deepEqual(pc.find((e) => e.slice === "notes-skill").files, [join(draft, "skills", "release-notes", "SKILL.md"), join(draft, "README.md")]);
      assert.deepEqual(pc.find((e) => e.slice === "readme").files, ["README.md"], "a project slice's FILES are logged as before");
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  }
  // Control: two project slices that both own README.md still collide, and a skill slice outside its planned FILES is not_in_plan.
  const s = setup({ reviewed: false });
  try {
    planned(s, `${PLAN}\nSLICE: other\nFILES: README.md\nDEPENDS: none`);
    assert.equal(launch(s, "SLICE: readme\nFILES: README.md\nDEPENDS: none").status, 0);
    const clash = launch(s, "SLICE: other\nFILES: README.md\nDEPENDS: none");
    assert.equal(clash.status, 2);
    assert.match(clash.stderr, /README\.md \(owned by readme\)/);
    const off = launch(s, "SLICE: notes-skill\nFILES: skills/other-thing/\nDEPENDS: none\nKIND: skill\nSKILL: release-notes");
    assert.equal(off.status, 2);
    assert.match(off.stderr, /outside its planned FILES/);
    // A skill brief for a slice the plan does not mark as a skill: its draft paths are not the planned project paths.
    const unmarked = launch(s, "SLICE: readme\nFILES: README.md\nDEPENDS: none\nKIND: skill\nSKILL: readme-skill");
    assert.equal(unmarked.status, 2);
    assert.match(unmarked.stderr, /outside its planned FILES/);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------- DRAFTS

test("DRAFTS: one SKILL.md line per draft of this run for implementer, researcher and reviewer; unknown names dropped and logged", () => {
  const s = setup();
  try {
    assert.equal(launch(s, skillBrief("release-notes")).status, 0);
    const draftMd = join(s.cfg, "orchestration", "skill-drafts", "private", "release-notes", "skills", "release-notes", "SKILL.md");
    const lines = `\n\nDraft skills of this run (added by the plan check): read each SKILL.md below before starting.\n- ${draftMd} (draft skill release-notes)`;
    for (const type of ["reviewer", "orchestration:researcher", "implementer"]) {
      const brief = type === "implementer" ? "SLICE: user\nFILES: notes.md\nDEPENDS: none\nDRAFTS: release-notes, ghost-skill" : "SLICE: user\nDRAFTS: release-notes, ghost-skill\nReview it.";
      const r = launch(s, brief, {}, type);
      assert.equal(r.status, 0, `${type}: ${r.stderr}`);
      assert.equal(out(r).updatedInput.prompt, `${brief}${lines}`, type);
    }
    const logs = logOf(s, "skill-create.jsonl").filter((e) => e.decision === "drafts");
    assert.equal(logs.length, 3);
    for (const e of logs) {
      assert.deepEqual([e.names, e.unknown, e.paths], [["release-notes"], ["ghost-skill"], [draftMd]]);
      assert.ok(!JSON.stringify(e).includes("Review it"));
    }
    // Only unknown names: nothing is appended, the decision is logged.
    const none = launch(s, "SLICE: user\nDRAFTS: ghost-skill", {}, "reviewer");
    assert.equal(none.stdout, "");
    assert.equal(logOf(s, "skill-create.jsonl").at(-1).reason, "none_known");
    // The integrator gets no DRAFTS lines.
    assert.equal(launch(s, "SLICE: user\nDRAFTS: release-notes", {}, "integrator").stdout, "");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("DRAFTS: a draft of another session is unknown", () => {
  const s = setup();
  try {
    assert.equal(launch(s, skillBrief("release-notes")).status, 0);
    const r = hook(s, "plan-check.mjs", { session_id: "s2", tool_name: "Agent", tool_input: { subagent_type: "reviewer", prompt: "SLICE: x\nDRAFTS: release-notes" } });
    assert.equal(r.stdout, "");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------- C3 and C5

test("C3: malformed input exits 0 silently, also with skill switches set", () => {
  const s = setup();
  try {
    for (const payload of ["not json", "null", "[]", "{}", { tool_input: "x" }, { session_id: 3, tool_input: { subagent_type: "implementer", prompt: 42 } }, { tool_input: { subagent_type: "implementer" } }]) {
      const r = hook(s, "plan-check.mjs", payload);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], JSON.stringify(payload));
    }
    for (const payload of ["not json", { hook_event_name: "SubagentStop", agent_type: "implementer", last_assistant_message: 7 }]) {
      const r = hook(s, "journal.mjs", payload);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    }
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("C5: briefs without the new lines are decided exactly as with skill creation off and no repos, and write no skill log", () => {
  const briefs = /** @type {[string, string][]} */ ([
    ["implementer", "SLICE: a\nFILES: a.py\nDEPENDS: none"],
    ["implementer", "SLICE: b\nFILES: a.py\nDEPENDS: none"],
    ["implementer", "Goal: no lines"],
    ["implementer", "SLICE: c\nFILES: README.md\nDEPENDS: none\nKIND: bugfix"],
    ["reviewer", "SLICE: a\nReview it."],
    ["researcher", "Find the thing."],
    ["integrator", "Merge a."],
  ]);
  /** @param {Record<string, string | undefined>} env */
  const runAll = (env) => {
    const s = setup();
    try {
      const results = briefs.map(([type, prompt]) => {
        const r = launch(s, prompt, env, type);
        return [r.status, r.stdout, r.stderr];
      });
      const pc = logOf(s, "plan-check.jsonl").map(({ ts, ...rest }) => rest);
      assert.equal(existsSync(join(s.dir, ".claude", "state", "skill-create.jsonl")), false, "no skill-create.jsonl");
      return { results, pc };
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  };
  const on = runAll({});
  const off = runAll({ ORCH_SKILL_CREATE: "off", ORCH_SKILLS_REPO_PRIVATE: undefined, ORCH_SKILLS_REPO_PUBLIC: undefined });
  assert.deepEqual(on, off);
  assert.deepEqual(on.results.map((r) => r[0]), [0, 2, 2, 0, 0, 0, 0]);
  assert.deepEqual(on.results.map((r) => r[1]), ["", "", "", "", "", "", ""], "no allow output without hints, haiku or skill lines");
});

test("DRAFTS and skill facts reach only our own implementer, researcher and reviewer; built-ins, fork, other plugins and the integrator keep their old output", () => {
  const known = "SLICE: user\nFILES: notes.md\nDEPENDS: none\nDRAFTS: release-notes";
  const others = ["general-purpose", "Explore", "fork", "foo:implementer", "foo:reviewer", "integrator", "orchestration:integrator"];
  // No run open: the built-ins take the builtin_outside_run allow.
  const s = setup();
  try {
    assert.equal(launch(s, skillBrief("release-notes")).status, 0);
    for (const type of others) {
      const r = launch(s, known, {}, type);
      assert.equal(r.stdout, "", `${type}: no output`);
    }
    // Another plugin's implementer with KIND: skill is not a skill slice: no facts, no skill-create record.
    const foreign = launch(s, skillBrief("foreign-skill"), {}, "foo:implementer");
    assert.deepEqual([foreign.status, foreign.stdout], [0, ""]);
    assert.equal(logOf(s, "skill-create.jsonl").some((e) => e.skill === "foreign-skill"), false);
    for (const type of ["reviewer", "orchestration:reviewer", "researcher", "orchestration:researcher"]) {
      assert.match(out(launch(s, "SLICE: user\nDRAFTS: release-notes", {}, type)).updatedInput.prompt, /\(draft skill release-notes\)$/, type);
    }
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
  // A run open: a built-in is blocked twice, then its builtin_agent_in_run_gave_up allow prints nothing either.
  const t = setup({ reviewed: false });
  try {
    planned(t, PLAN);
    assert.equal(launch(t, "SLICE: notes-skill\nFILES: skills/release-notes/\nDEPENDS: none\nKIND: skill\nSKILL: release-notes").status, 0);
    for (const type of ["general-purpose", "Explore"]) {
      assert.equal(launch(t, known, {}, type).status, 2);
      assert.equal(launch(t, known, {}, type).status, 2);
      const r = launch(t, known, {}, type);
      assert.deepEqual([r.status, r.stdout], [0, ""], `${type}: give-up allow prints nothing`);
    }
    assert.deepEqual(logOf(t, "plan-check.jsonl").filter((e) => e.reason === "builtin_agent_in_run_gave_up").length, 2);
    assert.match(out(launch(t, "SLICE: notes-skill\nDRAFTS: release-notes", {}, "reviewer")).updatedInput.prompt, /\(draft skill release-notes\)$/);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test("the hint block is checked as before: a hint row named update:x (a plugin named like a new key) still goes out", () => {
  const s = setup();
  try {
    // A reviewer gets one pick, so one launch per name.
    for (const n of ["update:x", "skill:y", "draft:z", "target:w", "drafts:v"]) {
      const r = launch(s, `SLICE: r\nSKILLS: ${n}\nReview it.`, { ORCH_SKILL_HINTS: "on" }, "reviewer");
      assert.equal(r.status, 0, r.stderr);
      assert.ok(String(out(r).updatedInput.prompt).endsWith(`\n- ${n} (explicit_not_found)`), n);
    }
    assert.equal(logOf(s, "skills.jsonl").filter((e) => e.decision === "dropped").length, 0);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
