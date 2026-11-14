// Keeps model, effort, maxTurns and the tool policy (tools, disallowedTools) in .claude/agents/*.md in step with ROLES
// and NATIVE_TOOLS in config.ts.
// Usage: tsx src/sync-agents.ts [--check]   (--check exits 1 on drift instead of writing)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TOOLS, ROLES, type NativeAgent, type Role } from "./config.js";

type Key = "model" | "effort" | "maxTurns";
type ToolKey = "tools" | "disallowedTools";
const TOOL_KEYS: ToolKey[] = ["tools", "disallowedTools"];
// triager and solo have no agent file: they only exist in the SDK pipeline.
const MAP: Partial<Record<Role, { agent: string; keys: Key[] }>> = {
  planner: { agent: "orchestrator", keys: ["model", "effort"] }, // main thread: no turn cap
  explorer: { agent: "researcher", keys: ["model", "effort", "maxTurns"] },
  writer: { agent: "implementer", keys: ["model", "effort", "maxTurns"] },
  verifier: { agent: "reviewer", keys: ["model", "effort", "maxTurns"] },
};

/** Agent files use aliases so they follow the newest model in a family; unknown ids stay verbatim. */
export const alias = (model: string): string => /fable|opus|sonnet|haiku/.exec(model)?.[0] ?? model;

function frontmatter(text: string): { whole: string; front: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error("no frontmatter");
  return { whole: m[0], front: m[1]! };
}

export function setKey(text: string, key: Key, value: string): string {
  const { whole, front } = frontmatter(text);
  const line = new RegExp(`^${key}:.*$`, "m");
  if (!line.test(front)) throw new Error(`frontmatter has no "${key}:" line`);
  return text.replace(whole, `---\n${front.replace(line, `${key}: ${value}`)}\n---`);
}

/**
 * Sets a frontmatter line, adding it when missing (after `maxTurns:`, else at the end of the frontmatter), or removes it
 * when `value` is undefined. The body is never touched.
 */
export function upsertKey(text: string, key: string, value: string | undefined): string {
  const { whole, front } = frontmatter(text);
  const line = new RegExp(`^${key}:.*(?:\\n|$)`, "m");
  let next: string;
  if (value === undefined) next = front.replace(line, "").replace(/\n$/, "");
  else if (line.test(front)) next = front.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`);
  else if (/^maxTurns:.*$/m.test(front)) next = front.replace(/^maxTurns:.*$/m, (m) => `${m}\n${key}: ${value}`);
  else next = `${front}\n${key}: ${value}`;
  return text.replace(whole, `---\n${next}\n---`);
}

export function syncAgents(agentsDir: string, check: boolean): string[] {
  const files = new Map<string, string>();
  const read = (agent: string) => files.get(agent) ?? readFileSync(join(agentsDir, `${agent}.md`), "utf8");
  for (const role of Object.keys(MAP) as Role[]) {
    const { agent, keys } = MAP[role]!;
    let text = read(agent);
    for (const key of keys) {
      const value = key === "model" ? alias(ROLES[role].model) : String(ROLES[role][key]);
      text = setKey(text, key, value);
    }
    files.set(agent, text);
  }
  for (const agent of Object.keys(NATIVE_TOOLS) as NativeAgent[]) {
    let text = read(agent);
    for (const key of TOOL_KEYS) text = upsertKey(text, key, NATIVE_TOOLS[agent][key]?.join(", "));
    files.set(agent, text);
  }
  const drift: string[] = [];
  for (const [agent, after] of files) {
    const file = join(agentsDir, `${agent}.md`);
    if (after !== readFileSync(file, "utf8")) {
      drift.push(`${agent}.md`);
      if (!check) writeFileSync(file, after);
    }
  }
  return drift.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const drift = syncAgents(join(process.cwd(), ".claude", "agents"), check);
  if (drift.length === 0) console.log("agents in sync with config.ts");
  else {
    console.log(`${check ? "out of sync" : "updated"}: ${drift.join(", ")}`);
    if (check) process.exit(1);
  }
}
