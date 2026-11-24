// The gate soak and the wave cap (2.1.0; scripts/soak-gates.mjs): the soak's random life cycles launch several
// implementers in one step, as a wave launched in one message reaches the plan check, and I1 checks that a wave never
// passes the cap together (the plan check's own caps stay keyed reason and slice, limit 2). Also the planted step,
// which now comes first, so a planted run finds its violation whatever its time box cuts off.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate, WAVE_CAP } from "../scripts/soak-gates.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "soak-gates.mjs");
/** @type {Record<string, string>} */
const env = Object.fromEntries(Object.entries(process.env).filter(/** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(ORCH_|NODE_OPTIONS$|NODE_TEST)/.test(e[0])));
/** @param {string[]} args */
const soak = (args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 5 * 60_000 + 30_000 });

test("a planted step is the first step of its sequence, so the time box never cuts it off", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const seq = generate(seed, 0, { plant: true });
    assert.equal(seq.ops[0]?.op, "planted", `seed ${seed}`);
    assert.equal(seq.ops.filter((/** @type {any} */ o) => o.op === "planted").length, 1);
  }
  assert.equal(generate(3, 0).ops.some((/** @type {any} */ o) => o.op === "planted"), false, "no plant without --plant");
});

test("some life cycles launch several implementers at once, before any other step of theirs", () => {
  let waves = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const seq = generate(seed, 0);
    const wave = seq.ops.find((/** @type {any} */ o) => o.op === "wave");
    if (!wave) continue;
    waves++;
    assert.ok(wave.as.length >= 2, "a wave is two or more launches");
    for (const i of wave.as) {
      assert.equal(seq.agents[i].role, "implementer");
      assert.equal(seq.ops.some((/** @type {any} */ o) => o.op === "launch" && o.a === i), false, "a wave member has no launch of its own");
      const first = seq.ops.findIndex((/** @type {any} */ o) => o.a === i);
      assert.ok(first === -1 || first > seq.ops.indexOf(wave), "its other steps come after the wave");
    }
  }
  assert.ok(waves >= 10, `waves in 200 sequences: ${waves}`);
  assert.equal(WAVE_CAP, 2, "the soak runs the plan check with a cap of 2, so a wave of three meets it");
});

/** A hand-built sequence: three implementers launched at once, each finishing with a hand-back. */
function waveSequence() {
  const agents = [0, 1, 2].map((i) => ({ i, role: "implementer", prefixed: i === 1, noId: false, slice: i === 1 ? "y" : "x", model: null, checks: false }));
  const ops = [{ op: "wave", as: [0, 1, 2] }, ...agents.map((a) => ({ op: "finish", a: a.i, mode: "handback", report: "ok", tests: "pass", where: "last", refix: true }))];
  return { v: 1, seed: 99, k: 0, headless: false, agents, ops };
}

test("a wave of three meets the cap of two: the real hooks pass the soak, a plan check without the cap is a finding", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-soak-wave-"));
  try {
    const file = join(dir, "seq.json");
    writeFileSync(file, `${JSON.stringify(waveSequence())}\n`);
    const ok = soak(["--minutes", "5", "--replay", file]);
    assert.equal(ok.status, 0, `the real hooks: no violation:\n${ok.stdout.slice(-3000)}\n${ok.stderr.slice(-1000)}`);
    // The same wave against a copy of the hooks without limits.mjs: the plan check judges no wave, and all three pass.
    const hooks = join(dir, "hooks");
    mkdirSync(hooks);
    for (const f of readdirSync(join(root, ".claude", "hooks"))) if (f !== "limits.mjs") copyFileSync(join(root, ".claude", "hooks", f), join(hooks, f));
    const bad = soak(["--minutes", "5", "--replay", file, "--hooks", hooks]);
    assert.equal(bad.status, 1, `a finding:\n${bad.stdout.slice(-3000)}`);
    assert.match(bad.stdout, /^VIOLATION I1_caps seed=99 sequence=0 step=0: wave: 3 of 3 launched at once passed with 0 running, over the cap of 2/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
