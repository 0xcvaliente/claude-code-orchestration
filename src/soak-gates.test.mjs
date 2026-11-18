// The gate soak (scripts/soak-gates.mjs, docs/data/probes-2.0.1-soak.md) in the suite: a fixed-seed round of a few
// sequences, the 60-minute limit, and a planted violation reported with its seed and a replayable sequence. Each run is
// a child process with its own deadline, so a loaded machine only cuts a round short (a cut sequence is not checked),
// never fails it; the planted runs stop when their one sequence ends, within a 1-minute cap.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "soak-gates.mjs");
/** @type {Record<string, string>} */
const env = Object.fromEntries(Object.entries(process.env).filter(/** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(ORCH_|NODE_OPTIONS$|NODE_TEST)/.test(e[0])));
/** @param {string[]} args */
const soak = (args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 60_000 });
/** The summary line's fields. @param {string} out */
const summary = (out) => Object.fromEntries([...(out.match(/^soak: (.*)$/m)?.[1] ?? "").matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));

test("the soak refuses a time box over 60 minutes, or one that is not a positive number, and runs nothing", () => {
  for (const bad of ["61", "60.5", "0", "-1", "abc", ""]) {
    const t0 = Date.now();
    const r = soak(["--minutes", bad]);
    assert.equal(r.status, 2, `--minutes ${JSON.stringify(bad)}: exit 2`);
    assert.match(r.stderr, bad === "61" || bad === "60.5" ? /over the 60-minute limit.*nothing was run/ : /positive number/);
    assert.doesNotMatch(r.stdout, /^soak:/m, "no round ran");
    assert.ok(Date.now() - t0 < 10_000, "refused at once");
  }
});

test("a fixed-seed round of two sequences finds no violation", () => {
  const t0 = Date.now();
  const r = soak(["--minutes", "0.25", "--seed", "20261118", "--sequences", "2", "--concurrency", "2"]);
  const s = summary(r.stdout);
  assert.equal(r.status, 0, `exit 0 with no violation:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-1000)}`);
  assert.equal(s.seed, "20261118");
  assert.equal(s.violations, "0");
  assert.ok(Number(s.hook_calls) > 0, "hook calls were made");
  assert.ok(Number(s.sequences) <= 2);
  assert.ok(Date.now() - t0 < 25_000, `within its time box plus the kill grace, took ${Date.now() - t0} ms`);
});

test("a planted violation is reported with its invariant, its seed and a sequence that replays it", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-soak-test-"));
  try {
    const r = soak(["--minutes", "1", "--seed", "7", "--sequences", "1", "--plant"]);
    assert.equal(r.status, 1, `exit 1 with a violation:\n${r.stdout.slice(-2000)}`);
    assert.match(r.stdout, /^VIOLATION I5_exitCodes seed=7 sequence=0 step=\d+: planted\.mjs exited 1/m);
    assert.match(summary(r.stdout).violations ?? "", /^[1-9]/);
    const line = r.stdout.split("\n").find((l) => l.startsWith("REPLAY "));
    assert.ok(line, "a REPLAY line");
    const seq = JSON.parse(line.slice("REPLAY ".length));
    assert.equal(seq.seed, 7);
    assert.ok(seq.ops.some((/** @type {any} */ o) => o.op === "planted"));
    // The printed sequence replays the violation.
    const file = join(dir, "seq.json");
    writeFileSync(file, `${line}\n`);
    const again = soak(["--minutes", "1", "--replay", file]);
    assert.equal(again.status, 1);
    assert.match(again.stdout, /^VIOLATION I5_exitCodes seed=7 sequence=0 step=\d+: planted\.mjs exited 1/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
