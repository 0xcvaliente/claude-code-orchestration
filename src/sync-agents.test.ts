import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alias, setKey, syncAgents } from "./sync-agents.js";

test("alias maps model ids to family aliases", () => {
  assert.equal(alias("claude-opus-5-5"), "opus");
  assert.equal(alias("claude-haiku-5-5"), "haiku");
  assert.equal(alias("some-custom-model"), "some-custom-model");
});

test("setKey rewrites only the frontmatter line", () => {
  const out = setKey("---\nname: x\nmodel: haiku\n---\nmodel: body stays\n", "model", "opus");
  assert.equal(out, "---\nname: x\nmodel: opus\n---\nmodel: body stays\n");
  assert.throws(() => setKey("---\nname: x\n---\n", "effort", "low"), /no "effort:"/);
});

test("syncAgents detects and fixes drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  cpSync(join(process.cwd(), ".claude", "agents"), dir, { recursive: true });
  assert.deepEqual(syncAgents(dir, true), [], "repo agents should start in sync");

  const file = join(dir, "implementer.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^effort:.*$/m, "effort: low"));
  assert.deepEqual(syncAgents(dir, true), ["implementer.md"]);
  assert.match(readFileSync(file, "utf8"), /effort: low/, "--check must not write");
  assert.deepEqual(syncAgents(dir, false), ["implementer.md"]);
  assert.match(readFileSync(file, "utf8"), /effort: medium/);
  assert.deepEqual(syncAgents(dir, true), []);
});
