// Every test file imports this module first (src/test-tmp.test.mjs checks it). `npm test` (scripts/run-tests.mjs) gives
// the suites one temp root and removes it at the end; a test file run directly (`npx tsx --test src/x.test.ts`,
// `node --test bench/y.test.mjs`) has no such root, and its temp folders used to stay in the system temp dir. Here such a
// process makes its own root: a folder `orch-test-XXXXXX` directly under the current temp dir, set as TMPDIR, TMP and
// TEMP (children inherit it), removed when the process exits, also after a failed test.
// A TMPDIR whose basename starts with `orch-test-` is a root someone else owns (npm test, or a parent test process):
// then this module does nothing. ORCH_KEEP_TEST_TMP=1 keeps the root and prints its path on stderr, as run-tests.mjs does.
// SIGINT, SIGTERM and SIGHUP remove the root too when nothing else in the process handles that signal; the handler then
// removes itself and sends the signal again, so the process still dies of it with the usual status.
// Nothing here throws: when the root cannot be made, the tests run with the temp dir they had.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const PREFIX = "orch-test-";

function setup() {
  try {
    const given = process.env.TMPDIR;
    if (given && basename(given).startsWith(PREFIX)) return;
    // directly under the temp dir and short: tsx opens a unix socket under TMPDIR, and a path over ~100 bytes fails
    const root = mkdtempSync(join(tmpdir(), PREFIX));
    process.env.TMPDIR = root;
    process.env.TMP = root;
    process.env.TEMP = root;
    const keep = process.env.ORCH_KEEP_TEST_TMP === "1";
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        if (keep) {
          process.stderr.write(`test temp folder kept: ${root}\n`);
          return;
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // a file still held open by a dying child: leave it, the test's result matters more
      }
    };
    process.on("exit", cleanup);
    for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
      /** @param {NodeJS.Signals} s */
      const onSignal = (s) => {
        // another listener owns this signal (the test itself): leave it be; a process.exit there still runs cleanup
        if (process.listenerCount(sig) > 1) return;
        cleanup();
        process.removeListener(sig, onSignal);
        try {
          process.kill(process.pid, s);
        } catch {
          process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1));
        }
      };
      process.on(sig, onSignal);
    }
  } catch {
    // no root: the tests use the temp dir they were given
  }
}

setup();
