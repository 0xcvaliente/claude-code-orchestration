// Triage only: print the route for a task as JSON, spend nothing else. Used by scripts/auto.sh for the native path.
// Usage: tsx src/route.ts --repo <dir> --task "<what to do>" [--mode auto|plain|orchestrate]
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { runAgent as baseAgent } from "./agent.js";
import { withTransientRetry } from "./retry.js";
import { decideRoute, logRoute, MODES, type RequestedMode } from "./auto.js";

const runAgent = withTransientRetry(baseAgent);

const { values } = parseArgs({
  options: { repo: { type: "string" }, task: { type: "string" }, mode: { type: "string", default: "auto" } },
});
if (!values.repo || !values.task || !MODES.includes(values.mode as RequestedMode)) {
  console.error(`usage: route.ts --repo <dir> --task "<task>" [--mode ${MODES.join("|")}]`);
  process.exit(2);
}

const repo = resolve(values.repo);
const decision = await decideRoute({ run: runAgent, repo, task: values.task, mode: values.mode as RequestedMode });
logRoute(join(repo, ".claude", "state"), values.task, decision);
console.log(JSON.stringify(decision));
