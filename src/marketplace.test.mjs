// The marketplace this repository is (`.claude-plugin/marketplace.json`): written by `npm run build-plugin`, compared by
// `npm run check-plugin`, and pointing at the committed dist/plugin. No git history and no network: the build runs into
// temp dirs, and the stale-file check runs against a scratch copy of the project, never against the real file.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "build-plugin.mjs");
const REPO = "https://github.com/0xcvaliente/claude-code-orchestration";
// Names Claude Code keeps for itself (its plugin marketplace docs): a marketplace may not take one, and a plugin name may
// not start with one of the prefixes.
const RESERVED_MARKETPLACES = ["claude-plugins-official", "claude-code-marketplace", "claude-code-plugins", "anthropic-marketplace", "anthropic-plugins", "agent-skills"];
const RESERVED_PREFIXES = ["claude-", "anthropic-", "anthropics-", "cc-plugin-"];

/** @param {string} p */
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const MANIFESTS = [".claude-plugin/marketplace.json", "dist/plugin/.claude-plugin/plugin.json", "dist/dashboard/.claude-plugin/plugin.json"];

test("the committed marketplace file is exactly what the build writes", () => {
  const out = mkdtempSync(join(tmpdir(), "marketplace-out-"));
  try {
    const r = spawnSync("node", [script, "--out", out], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(out, "marketplace.json"), "utf8"), readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the marketplace keeps its name and owner, and lists the orchestration plugin with every field people see", () => {
  const m = read(".claude-plugin/marketplace.json");
  // Renaming the marketplace would drop it for everyone who already added it.
  assert.equal(m.name, "claude-code-orchestration");
  assert.deepEqual(m.owner, { name: "0xcvaliente" });
  assert.ok(typeof m.description === "string" && m.description.length > 20, "a marketplace description");
  assert.equal(m.plugins.length, 1);
  const [p] = m.plugins;
  assert.equal(p.name, "orchestration");
  assert.equal(p.source, "./dist/plugin");
  // No version in the entry: with one in both, Claude Code silently takes plugin.json's (its host-marketplace docs).
  assert.equal(Object.hasOwn(p, "version"), false, "the marketplace entry sets no version");
  assert.equal(p.homepage, REPO);
  assert.equal(p.repository, REPO);
  assert.ok(typeof p.description === "string" && p.description.length > 20, "a plugin description");
  assert.ok(typeof p.category === "string" && p.category.length > 0, "a category");
  assert.ok(Array.isArray(p.tags) && p.tags.length > 0 && p.tags.every((/** @type {unknown} */ t) => typeof t === "string"), "tags");
});

test("the entry's source holds the built plugin, with the same name and the version from package.json", () => {
  const m = read(".claude-plugin/marketplace.json");
  for (const p of m.plugins) {
    const manifest = join(root, p.source, ".claude-plugin", "plugin.json");
    assert.ok(existsSync(manifest), `${p.source} holds .claude-plugin/plugin.json`);
    const pj = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(pj.name, p.name);
    // The version lives in plugin.json only; people get a new copy when it changes.
    assert.equal(pj.version, read("package.json").version);
  }
});

test("no reserved marketplace name and no reserved plugin name prefix", () => {
  const m = read(".claude-plugin/marketplace.json");
  assert.ok(!RESERVED_MARKETPLACES.includes(m.name), m.name);
  const names = [...m.plugins.map((/** @type {any} */ p) => p.name), read("dist/plugin/.claude-plugin/plugin.json").name, read("dist/dashboard/.claude-plugin/plugin.json").name];
  for (const n of names) {
    assert.match(n, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${n} is kebab-case`);
    for (const pre of RESERVED_PREFIXES) assert.ok(!n.startsWith(pre), `${n} starts with ${pre}`);
  }
});

test("2.0.3: the license is MIT in package.json and both plugin manifests, and the marketplace states it nowhere (one place per fact)", () => {
  /** @param {unknown} v @returns {string[]} */
  const keys = (v) => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
  assert.equal(read("package.json").license, "MIT", "package.json");
  for (const f of ["dist/plugin/.claude-plugin/plugin.json", "dist/dashboard/.claude-plugin/plugin.json"]) assert.equal(read(f).license, "MIT", f);
  assert.ok(!keys(read(".claude-plugin/marketplace.json")).includes("license"), "no license field in the marketplace file");
});

test("2.0.3: the marketplace entry carries no icon (a plugin.json field only)", () => {
  /** @param {unknown} v @returns {string[]} */
  const keys = (v) => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
  assert.ok(!keys(read(".claude-plugin/marketplace.json")).includes("icon"), "no icon field in the marketplace file");
  assert.equal(read("dist/plugin/.claude-plugin/plugin.json").icon, "./icon.png", "the plugin names its icon");
});

test("no email address in the three manifests", () => {
  for (const f of MANIFESTS) assert.doesNotMatch(readFileSync(join(root, f), "utf8"), /[\w.+-]+@[\w-]+\.[\w.-]+/, `${f}: no email address`);
});

test("--check fails, naming the file, when the marketplace file is stale or missing (scratch copy of the project)", () => {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-proj-"));
  try {
    cpSync(join(root, ".claude"), join(dir, ".claude"), {
      recursive: true,
      filter: (p) => !/[\\/](worktrees|state)([\\/]|$)/.test(p.slice(root.length)),
    });
    cpSync(join(root, "dashboard"), join(dir, "dashboard"), { recursive: true });
    cpSync(join(root, "package.json"), join(dir, "package.json"));
    cpSync(join(root, "LICENSE"), join(dir, "LICENSE"));
    cpSync(join(root, "plugin-assets"), join(dir, "plugin-assets"), { recursive: true });
    const check = () => spawnSync("node", [script, "--check"], { cwd: dir, encoding: "utf8" });
    assert.equal(spawnSync("node", [script], { cwd: dir, encoding: "utf8" }).status, 0);
    const file = join(dir, ".claude-plugin", "marketplace.json");
    assert.ok(existsSync(file), "the build writes .claude-plugin/marketplace.json");
    assert.equal(check().status, 0, check().stderr);
    const fresh = readFileSync(file, "utf8");
    // A hand edit: stale.
    writeFileSync(file, fresh.replace('"orchestration"', '"orchestration-renamed"'));
    const stale = check();
    assert.equal(stale.status, 1, "a hand-edited marketplace file must fail the check");
    assert.match(stale.stderr, /\.claude-plugin\/marketplace\.json is out of date; run npm run build-plugin/);
    // dist/ stays fresh throughout: only the marketplace file fails it.
    assert.doesNotMatch(stale.stderr, /dist\/(plugin|dashboard) is out of date/);
    writeFileSync(file, fresh);
    assert.equal(check().status, 0);
    // Missing: stale.
    rmSync(file);
    const missing = check();
    assert.equal(missing.status, 1, "a missing marketplace file must fail the check");
    assert.match(missing.stderr, /marketplace\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
