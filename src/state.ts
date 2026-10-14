import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./config.js";
import type { AgentResult } from "./agent.js";

/** Second-resolution timestamp plus a random suffix: two runs in one second must not share branch names. */
export const newRunId = () => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;

/** One run's directory: telemetry log, saved artifacts, and the running cost total. */
export class Run {
  readonly dir: string;
  spentUsd = 0;
  private byRole: Partial<Record<Role, number>> = {};

  constructor(readonly id: string, outRoot: string) {
    this.dir = join(outRoot, id);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Record a worker's cost and append a telemetry line. */
  charge(role: Role, label: string, res: AgentResult) {
    // A missing or NaN cost must not poison the total: NaN would make every budget check pass.
    const cost = Number.isFinite(res.costUsd) ? res.costUsd : 0;
    this.spentUsd += cost;
    this.byRole[role] = (this.byRole[role] ?? 0) + cost;
    const { text, structured, ...meta } = res;
    appendFileSync(
      join(this.dir, "telemetry.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), role, label, ...meta, preview: text.slice(0, 200) }) + "\n",
    );
  }

  overBudget(limitUsd: number) {
    return this.spentUsd >= limitUsd;
  }

  costByRole() {
    return { ...this.byRole };
  }

  save(name: string, data: unknown) {
    writeFileSync(join(this.dir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
}
