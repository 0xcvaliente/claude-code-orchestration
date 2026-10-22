// Smoke test for ORCH_SANDBOX: one real query() with the OS sandbox on, using the real `sandboxFor` options.
// Needs a logged-in `claude`. Run with tsx (it imports src/agent.ts):
//   npx tsx scripts/sandbox-smoke.mjs <scratch-dir> [--deny-home]
// The worker is asked to create (1) <scratch-dir>/cwd/in.txt, inside its cwd (must work), and (2) an empty marker file
// directly in the home folder, which is neither under the cwd nor under tmpdir() (must be blocked). The marker is the
// only path outside <scratch-dir> this script ever touches; it is deleted in a `finally` and its absence is checked.
// --deny-home adds the home folder to filesystem.denyWrite in this script's own options (diagnostic only).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { sandboxFor } from "../src/agent.js";

if (!process.argv[2]) {
  console.error("usage: npx tsx scripts/sandbox-smoke.mjs <scratch-dir> [--deny-home]");
  process.exit(2);
}
const cwd = join(resolve(process.argv[2]), "cwd");
const marker = join(homedir(), ".orchestration-sandbox-smoke-" + randomBytes(4).toString("hex"));
rmSync(cwd, { recursive: true, force: true });
mkdirSync(cwd, { recursive: true });

const sandbox = sandboxFor({ ORCH_SANDBOX: "on" }, cwd);
if (process.argv.includes("--deny-home") && sandbox?.filesystem) sandbox.filesystem.denyWrite = [homedir()];

let outcome = "no result";
let toolErrors = [];
let inOk = false, outBlocked = false, cleaned = false;
try {
  for await (const msg of query({
    prompt:
      `Using the Bash tool, run exactly these two commands, one tool call each, then stop:\n` +
      `1. echo ok > ${join(cwd, "in.txt")}\n2. : > ${marker}\n` +
      `Do not try another way if one fails. Then quote the exact error text of any failed command.`,
    options: {
      cwd, model: process.env.ORCH_MODEL_SOLO || "claude-sonnet-5-5", maxTurns: 6,
      tools: ["Bash"], allowedTools: ["Bash"], permissionMode: "dontAsk", settingSources: [], persistSession: false, sandbox,
    },
  })) {
    if (msg.type === "result") outcome = msg.subtype === "success" ? msg.result.slice(0, 600) : `${msg.subtype}: ${(msg.errors ?? []).join("; ")}`;
  }
} catch (err) {
  outcome = `exception: ${err instanceof Error ? err.message : String(err)}`;
} finally {
  inOk = existsSync(join(cwd, "in.txt")) && readFileSync(join(cwd, "in.txt"), "utf8").trim() === "ok";
  outBlocked = !existsSync(marker);
  rmSync(marker, { force: true });
  cleaned = !existsSync(marker);
}
console.log(JSON.stringify({ sandbox, outcome, insideCwdWritten: inOk, homeMarkerBlocked: outBlocked, markerCleanedUp: cleaned }, null, 2));
process.exit(inOk && outBlocked && cleaned ? 0 : 1);
