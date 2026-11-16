// Triage only: print the route for a task as JSON, spend nothing else. Used by scripts/auto.sh and the /route skill.
// Usage: tsx src/route.ts --repo <folder> --task "<what to do>" [--mode auto|plain|reviewed|orchestrate] [--project-state]
// --repo is the folder the task is about: a code repository or any other folder. A git repository is not required, and
// neither this script nor the triage it runs calls git. The JSON carries `facts.code` (does the task change code?) beside
// the other facts; there are no facts when --mode forces a route or triage fails, and the caller then decides from the folder.
// The decision is appended to routes.jsonl in the folder's state dir (.claude/hooks/state.mjs): <folder>/.claude/state
// when the folder registers its own hooks or --project-state is given (auto.sh, beside runs.jsonl), else the per-user
// dir the plugin hooks log to, so a plugin install writes nothing into the user's folder.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runAgent as baseAgent } from "./agent.js";
import { withTransientRetry } from "./retry.js";
import { decideRoute, logRoute, MODES, type RequestedMode } from "./auto.js";
import { ensureStateDir, stateDirFor } from "../.claude/hooks/state.mjs";

const runAgent = withTransientRetry(baseAgent);

function usage(problem?: string): never {
  console.error(
    (problem ? `${problem}\n` : "") +
      `usage: route.ts --repo <folder> --task "<task>" [--mode ${MODES.join("|")}] [--project-state]\n` +
      "  --repo is the folder the task is about: any folder works, a git repository is not required\n" +
      "  a task that starts with a dash goes as --task=<task>",
  );
  process.exit(2);
}

// parseArgs throws on an unknown flag, a missing value or a value that starts with a dash: that is a usage error.
let parsed;
try {
  parsed = parseArgs({
    options: {
      repo: { type: "string" },
      task: { type: "string" },
      mode: { type: "string", default: "auto" },
      "project-state": { type: "boolean", default: false },
    },
  });
} catch (err) {
  usage(err instanceof Error ? err.message : String(err));
}
const { values } = parsed;
if (!values.repo || !values.task || !MODES.includes(values.mode as RequestedMode)) usage();

const repo = resolve(values.repo);
const decision = await decideRoute({ run: runAgent, repo, task: values.task, mode: values.mode as RequestedMode });
const state = stateDirFor(repo, { plugin: !values["project-state"] });
ensureStateDir(state);
logRoute(state.dir, values.task, decision);
console.log(JSON.stringify(decision));
