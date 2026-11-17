// Not a hook: the content identity of this repo's saved workflow, read by workflow-guard.mjs. The guard lets a saved
// workflow name through only when the file Claude Code loads for it hashes to one of these values, so a file of other
// content at the saved name (one a model wrote, or another project's own `orchestrate` workflow) is refused.
// Two values, because the build rewrites the copy it ships: `npm run build-plugin` copies .claude/workflows/orchestrate.js
// into dist/plugin/workflows/ and turns every `agentType: '<role>'` into `agentType: 'orchestration:<role>'`.
// - PROJECT_WORKFLOW_SHA256: .claude/workflows/orchestrate.js (the name `orchestrate`).
// - PLUGIN_WORKFLOW_SHA256: dist/plugin/workflows/orchestrate.js (the name `orchestration:orchestrate`).
// After any change to the workflow, run `npm run build-plugin`, then src/workflow-guard.test.mjs, which fails and prints
// the line to paste here for each value that no longer matches; then build again so the plugin ships this file.
// The hash is SHA-256 over the file's bytes with each CRLF read as LF (a Windows checkout), nothing else changed.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

/** Larger files are not this workflow (it is about 50 KB). */
const MAX_BYTES = 4 * 1024 * 1024;

export const PROJECT_WORKFLOW_SHA256 = "8fb66f7fd871d3ed879b3eb1c83e7af6f02afdd0b51a345b39e6c4fa7dbc2c8a";
export const PLUGIN_WORKFLOW_SHA256 = "83b30561f8ded3eb721b17aa8643aca892e63a272fdc9f72a02a477ee4ecbe34";

/** SHA-256 (hex) of a workflow file's bytes, CRLF read as LF. @param {Buffer} bytes */
export function workflowSha256(bytes) {
  return createHash("sha256").update(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1").digest("hex");
}

/** Nothing exists at the path (not even a dangling link). */
export const MISSING = "missing";
/** Something exists at the path but cannot be hashed: unreadable, not a regular file, too large, a dangling link. */
export const UNHASHABLE = "unhashable";

/** True when nothing at all exists at `p` (lstat says ENOENT or ENOTDIR); anything else counts as existing. @param {string} p */
function nothingAt(p) {
  try {
    lstatSync(p);
    return false;
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/**
 * The hash of the regular file at `p`; MISSING when nothing exists there; UNHASHABLE when something exists that cannot
 * be hashed. The guard skips only MISSING: an unhashable candidate refuses, so it can never pass for a missing one. It
 * opens without blocking and checks the opened file, so a FIFO or a device at the path cannot stall the hook past its
 * timeout (a hook that times out does not block the tool).
 * @param {string} p
 * @returns {string}
 */
export function fileHash(p) {
  if (nothingAt(p)) return MISSING;
  /** @type {number | undefined} */
  let fd;
  try {
    fd = openSync(p, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return UNHASHABLE;
    return workflowSha256(readFileSync(fd));
  } catch {
    return UNHASHABLE;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** The hash of the regular file at `p`, or null when it is missing or cannot be hashed (tests and the drift check). @param {string} p */
export function fileSha256(p) {
  const h = fileHash(p);
  return h === MISSING || h === UNHASHABLE ? null : h;
}
