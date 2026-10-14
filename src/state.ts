import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./config.js";
import type { AgentResult } from "./agent.js";

/** Second-resolution timestamp plus a random suffix: two runs in one second must not share branch names. */
export const newRunId = () => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;

/** One run's directory: telemetry log, saved artifacts, and the running token total. */
export class Run {
  readonly dir: string;
  spentTokens = 0;
  private byRole: Partial<Record<Role, number>> = {};

  constructor(readonly id: string, outRoot: string) {
    this.dir = join(outRoot, id);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Record a worker's tokens and append a telemetry line. */
  charge(role: Role, label: string, res: AgentResult) {
    // A missing or NaN count must not poison the total: NaN would make every budget check pass.
    const tokens = Number.isFinite(res.tokens) ? res.tokens : 0;
    this.spentTokens += tokens;
    this.byRole[role] = (this.byRole[role] ?? 0) + tokens;
    const { text, structured, ...meta } = res;
    appendFileSync(
      join(this.dir, "telemetry.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), role, label, ...meta, preview: text.slice(0, 200) }) + "\n",
    );
  }

  overBudget(limitTokens: number) {
    return this.spentTokens >= limitTokens;
  }

  tokensByRole() {
    return { ...this.byRole };
  }

  save(name: string, data: unknown) {
    writeFileSync(join(this.dir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
}
