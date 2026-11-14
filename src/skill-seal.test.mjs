// skill-seal.mjs: seal() and verify() on temp skill folders, and the CLI's exit codes. Nothing here touches a real
// skills repository or the real ~/.claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createdBy, seal, verify } from "../.claude/hooks/skill-seal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, ".claude", "hooks", "skill-seal.mjs");
const sha = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex");

/** A skill folder `<tmp>/<name>` with SKILL.md and references/a.md. @param {string} [name] */
function skill(name = "demo-skill") {
  const base = mkdtempSync(join(tmpdir(), "skill-seal-"));
  const dir = join(base, name);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: A demo.\n---\nBody\n`);
  writeFileSync(join(dir, "references", "a.md"), "Ref\n");
  return { base, dir };
}
/** @param {string} dir */
const sealOf = (dir) => JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"));
/** @param {string[]} args */
const cli = (args) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });

test("seal writes the provenance record and verify accepts it", () => {
  const { base, dir } = skill();
  try {
    const rec = seal(dir, { target: "public", now: new Date("2026-01-02T03:04:05.000Z") });
    const onDisk = sealOf(dir);
    assert.deepEqual(onDisk, rec);
    assert.equal(rec.v, 1);
    assert.equal(rec.name, "demo-skill");
    assert.equal(rec.created_at, "2026-01-02T03:04:05.000Z");
    assert.equal(rec.target, "public");
    assert.deepEqual(Object.keys(rec.files), ["SKILL.md", "references/a.md"], "sorted POSIX paths, the seal itself left out");
    assert.equal(rec.files["references/a.md"], sha("Ref\n"));
    const lines = Object.entries(rec.files).map(([p, h]) => `${p}:${h}`).join("\n");
    assert.equal(rec.digest, sha(lines));
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    assert.equal(rec.created_by, `claude-code-orchestration ${version}`, "the project copy finds the package version");
    assert.equal(createdBy(), rec.created_by);
    assert.deepEqual(verify(dir), { ok: true, problems: [] });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sealing again keeps created_at and the target, and picks up new files", () => {
  const { base, dir } = skill();
  try {
    seal(dir, { target: "public", now: new Date("2026-01-01T00:00:00.000Z") });
    writeFileSync(join(dir, "references", "b.md"), "B\n");
    const again = seal(dir, { now: new Date("2027-01-01T00:00:00.000Z") });
    assert.equal(again.created_at, "2026-01-01T00:00:00.000Z");
    assert.equal(again.target, "public");
    assert.ok("references/b.md" in again.files);
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the target defaults to private, or to the draft home's target folder", () => {
  const { base, dir } = skill();
  const home = mkdtempSync(join(tmpdir(), "skill-seal-home-"));
  try {
    assert.equal(seal(dir).target, "private");
    const draft = join(home, "orchestration", "skill-drafts", "public", "demo-skill", "skills", "demo-skill");
    mkdirSync(draft, { recursive: true });
    writeFileSync(join(draft, "SKILL.md"), "x\n");
    assert.equal(seal(draft).target, "public");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify names each kind of problem", () => {
  const { base, dir } = skill();
  try {
    assert.deepEqual(verify(dir), { ok: false, problems: ["provenance.json is missing or unreadable"] });
    seal(dir);
    writeFileSync(join(dir, "SKILL.md"), "changed\n");
    assert.deepEqual(verify(dir).problems, ["SKILL.md changed after the seal"]);
    seal(dir);
    unlinkSync(join(dir, "references", "a.md"));
    assert.deepEqual(verify(dir).problems, ["references/a.md is listed in the seal but is gone"]);
    seal(dir);
    writeFileSync(join(dir, "extra.md"), "x\n");
    assert.deepEqual(verify(dir).problems, ["extra.md is not listed in the seal"]);
    seal(dir);
    const s = sealOf(dir);
    writeFileSync(join(dir, "provenance.json"), JSON.stringify({ ...s, digest: "0".repeat(64) }));
    assert.deepEqual(verify(dir).problems, ["the seal's digest does not match its file list"]);
    writeFileSync(join(dir, "provenance.json"), "{not json");
    assert.deepEqual(verify(dir).problems, ["provenance.json is not valid JSON"]);
    writeFileSync(join(dir, "provenance.json"), JSON.stringify({ v: 2 }));
    assert.deepEqual(verify(dir).problems, ["provenance.json does not have the expected fields"]);
    assert.equal(verify(join(base, "nowhere")).ok, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a symlink makes seal fail and verify report it; it is never followed", () => {
  const { base, dir } = skill();
  try {
    writeFileSync(join(base, "outside.txt"), "secret\n");
    symlinkSync(join(base, "outside.txt"), join(dir, "references", "link.md"));
    assert.throws(() => seal(dir), /references\/link\.md is a symlink/);
    unlinkSync(join(dir, "references", "link.md"));
    seal(dir);
    symlinkSync(join(base, "outside.txt"), join(dir, "link.md"));
    const v = verify(dir);
    assert.equal(v.ok, false);
    assert.match(v.problems.join("\n"), /link\.md is a symlink/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI: 0 on seal and verify, 1 on a failed verify or seal with problems on stderr, 2 on bad usage", () => {
  const { base, dir } = skill();
  try {
    const sealed = cli([dir, "--target", "public"]);
    assert.equal(sealed.status, 0, sealed.stderr);
    assert.equal(sealOf(dir).target, "public");
    assert.equal(cli([dir, "--verify"]).status, 0);
    writeFileSync(join(dir, "SKILL.md"), "changed\n");
    const bad = cli([dir, "--verify"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /SKILL\.md changed after the seal/);
    symlinkSync(join(dir, "SKILL.md"), join(dir, "l.md"));
    const refused = cli([dir]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /symlink/);
    for (const args of [[], [dir, dir], [dir, "--target"], [dir, "--target", "secret"], [dir, "--bogus"], [dir, "--verify", "--target", "private"]]) {
      const r = cli(args);
      assert.equal(r.status, 2, `${args.join(" ")}`);
      assert.match(r.stderr, /usage:/);
    }
    assert.equal(cli([join(base, "missing")]).status, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("created_by: the plugin copy reads the plugin manifest; with neither manifest it names the tool alone", () => {
  const base = mkdtempSync(join(tmpdir(), "skill-seal-copy-"));
  try {
    const plugin = join(base, "plugin");
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "orchestration", version: "9.8.7" }));
    writeFileSync(join(plugin, "hooks", "skill-seal.mjs"), readFileSync(CLI));
    const bare = join(base, "bare", "a", "hooks");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(base, "bare", "package.json"), JSON.stringify({ name: "someone-else", version: "1.0.0" }));
    writeFileSync(join(bare, "skill-seal.mjs"), readFileSync(CLI));
    for (const [hooks, want] of /** @type {[string, string][]} */ ([[join(plugin, "hooks"), "claude-code-orchestration 9.8.7"], [bare, "claude-code-orchestration"]])) {
      const dir = join(base, `s-${want.length}`, "demo");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "x\n");
      const r = spawnSync("node", [join(String(hooks), "skill-seal.mjs"), dir], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(sealOf(dir).created_by, want);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("seal and verify refuse a skill folder that is itself a symlink", () => {
  const { base, dir } = skill();
  try {
    seal(dir);
    const link = join(base, "linked");
    symlinkSync(dir, link);
    assert.throws(() => seal(link), /is a symlink/);
    assert.deepEqual(verify(link), { ok: false, problems: ["the skill folder is a symlink; a sealed skill is a real folder"] });
    assert.equal(cli([link, "--verify"]).status, 1);
    assert.equal(cli([link]).status, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
