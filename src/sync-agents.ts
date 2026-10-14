// Keeps model, effort and maxTurns in .claude/agents/*.md in step with ROLES in config.ts.
// Usage: tsx src/sync-agents.ts [--check]   (--check exits 1 on drift instead of writing)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES, type Role } from "./config.js";

type Key = "model" | "effort" | "maxTurns";
// triager and solo have no agent file: they only exist in the SDK pipeline.
const MAP: Partial<Record<Role, { agent: string; keys: Key[] }>> = {
  planner: { agent: "orchestrator", keys: ["model", "effort"] }, // main thread: no turn cap
  explorer: { agent: "researcher", keys: ["model", "effort", "maxTurns"] },
  writer: { agent: "implementer", keys: ["model", "effort", "maxTurns"] },
  verifier: { agent: "reviewer", keys: ["model", "effort", "maxTurns"] },
};

/** Agent files use aliases so they follow the newest model in a family; unknown ids stay verbatim. */
export const alias = (model: string): string => /opus|sonnet|haiku/.exec(model)?.[0] ?? model;

export function setKey(text: string, key: Key, value: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error("no frontmatter");
  const line = new RegExp(`^${key}:.*$`, "m");
  const front = m[1]!;
  if (!line.test(front)) throw new Error(`frontmatter has no "${key}:" line`);
  return text.replace(m[0], `---\n${front.replace(line, `${key}: ${value}`)}\n---`);
}

export function syncAgents(agentsDir: string, check: boolean): string[] {
  const drift: string[] = [];
  for (const role of Object.keys(MAP) as Role[]) {
    const { agent, keys } = MAP[role]!;
    const file = join(agentsDir, `${agent}.md`);
    const before = readFileSync(file, "utf8");
    let after = before;
    for (const key of keys) {
      const value = key === "model" ? alias(ROLES[role].model) : String(ROLES[role][key]);
      after = setKey(after, key, value);
    }
    if (after !== before) {
      drift.push(`${agent}.md`);
      if (!check) writeFileSync(file, after);
    }
  }
  return drift;
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
