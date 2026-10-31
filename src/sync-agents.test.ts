import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alias, setKey, syncAgents, upsertKey } from "./sync-agents.js";

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

test("syncAgents detects and fixes tool-policy drift: a removed disallowedTools, a loosened or added tools line", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  cpSync(join(process.cwd(), ".claude", "agents"), dir, { recursive: true });
  const implementer = join(dir, "implementer.md");
  const original = readFileSync(implementer, "utf8");
  assert.match(original, /^disallowedTools: Agent$/m);

  writeFileSync(implementer, original.replace(/^disallowedTools:.*\n/m, ""));
  assert.deepEqual(syncAgents(dir, true), ["implementer.md"]);
  assert.deepEqual(syncAgents(dir, false), ["implementer.md"]);
  assert.equal(readFileSync(implementer, "utf8"), original);

  writeFileSync(implementer, original.replace(/^disallowedTools:.*\n/m, "tools: Read, Agent\n"));
  assert.deepEqual(syncAgents(dir, false), ["implementer.md"]);
  assert.equal(readFileSync(implementer, "utf8"), original, "a tools line the policy does not name is removed");

  const reviewer = join(dir, "reviewer.md");
  const before = readFileSync(reviewer, "utf8");
  writeFileSync(reviewer, before.replace(/^tools:.*$/m, "tools: Read, Grep, Glob, Bash, Edit, Write"));
  assert.deepEqual(syncAgents(dir, true), ["reviewer.md"]);
  assert.deepEqual(syncAgents(dir, false), ["reviewer.md"]);
  assert.equal(readFileSync(reviewer, "utf8"), before);
  assert.deepEqual(syncAgents(dir, true), []);
});

test("upsertKey adds after maxTurns, replaces, removes, and never touches the body", () => {
  const doc = "---\nname: x\nmaxTurns: 5\nskills:\n  - s\n---\ntools: body\n";
  const added = upsertKey(doc, "disallowedTools", "Agent");
  assert.equal(added, "---\nname: x\nmaxTurns: 5\ndisallowedTools: Agent\nskills:\n  - s\n---\ntools: body\n");
  assert.equal(upsertKey(added, "disallowedTools", "Agent, Bash"), added.replace("Agent\n", "Agent, Bash\n"));
  assert.equal(upsertKey(added, "disallowedTools", undefined), doc);
  assert.equal(upsertKey(doc, "tools", undefined), doc);
  assert.equal(upsertKey("---\nname: x\n---\n", "tools", "Read"), "---\nname: x\ntools: Read\n---\n");
});
