// Triage only: print the route for a task as JSON, spend nothing else. Used by scripts/auto.sh and the /route skill.
// Usage: tsx src/route.ts --repo <dir> --task "<what to do>" [--mode auto|plain|orchestrate] [--project-state]
// The decision is appended to routes.jsonl in the repo's state dir (.claude/hooks/state.mjs): <repo>/.claude/state
// when the repo registers its own hooks or --project-state is given (auto.sh, beside runs.jsonl), else the per-user
// dir the plugin hooks log to, so a plugin install writes nothing into the user's repo.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runAgent as baseAgent } from "./agent.js";
import { withTransientRetry } from "./retry.js";
import { decideRoute, logRoute, MODES, type RequestedMode } from "./auto.js";
import { ensureStateDir, stateDirFor } from "../.claude/hooks/state.mjs";

const runAgent = withTransientRetry(baseAgent);

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    task: { type: "string" },
    mode: { type: "string", default: "auto" },
    "project-state": { type: "boolean", default: false },
  },
});
if (!values.repo || !values.task || !MODES.includes(values.mode as RequestedMode)) {
  console.error(`usage: route.ts --repo <dir> --task "<task>" [--mode ${MODES.join("|")}] [--project-state]`);
  process.exit(2);
}

const repo = resolve(values.repo);
const decision = await decideRoute({ run: runAgent, repo, task: values.task, mode: values.mode as RequestedMode });
const state = stateDirFor(repo, { plugin: !values["project-state"] });
ensureStateDir(state);
logRoute(state.dir, values.task, decision);
console.log(JSON.stringify(decision));
