import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate, criticalPath, formatGantt } from "./index.js";

const A = (id, attempt, start, end, ok = true) => ({ id, attempt, start, end, ok });

test("chain on one worker", () => {
  const r = simulate([{ id: "a", duration: 2 }, { id: "b", duration: 3, deps: ["a"] }], { workers: 1 });
  assert.deepEqual(r, { makespan: 5, attempts: [A("a", 1, 0, 2), A("b", 1, 2, 5)], status: { a: "done", b: "done" } });
});

test("parallel workers, priority and id tie-breaks", () => {
  assert.equal(simulate([{ id: "a", duration: 2 }, { id: "b", duration: 3 }], { workers: 2 }).makespan, 3);
  const p = simulate([{ id: "a", duration: 2 }, { id: "b", duration: 3, priority: 5 }], { workers: 1 });
  assert.deepEqual(p.attempts, [A("b", 1, 0, 3), A("a", 1, 3, 5)]);
  const t = simulate([{ id: "c", duration: 1 }, { id: "a", duration: 1 }, { id: "b", duration: 1 }], { workers: 1 });
  assert.deepEqual(t.attempts.map((x) => x.id), ["a", "b", "c"]);
  const hi = simulate([{ id: "z", duration: 1, priority: 10 }, { id: "a", duration: 1, priority: 1 }, { id: "m", duration: 1, priority: 10 }], { workers: 1 });
  assert.deepEqual(hi.attempts.map((x) => x.id), ["m", "z", "a"]);
});

test("diamond with 2 and 1 workers", () => {
  const jobs = [{ id: "a", duration: 1 }, { id: "b", duration: 2, deps: ["a"] }, { id: "c", duration: 3, deps: ["a"] }, { id: "d", duration: 1, deps: ["b", "c"] }];
  const two = simulate(jobs, { workers: 2 });
  assert.equal(two.makespan, 5);
  assert.deepEqual(two.attempts, [A("a", 1, 0, 1), A("b", 1, 1, 3), A("c", 1, 1, 4), A("d", 1, 4, 5)]);
  const one = simulate(jobs, { workers: 1 });
  assert.equal(one.makespan, 7);
  assert.deepEqual(one.attempts, [A("a", 1, 0, 1), A("b", 1, 1, 3), A("c", 1, 3, 6), A("d", 1, 6, 7)]);
});

test("resources are held for the whole attempt and released at completion", () => {
  const r = simulate([{ id: "x", duration: 2, needs: { gpu: 1 } }, { id: "y", duration: 2, needs: { gpu: 1 } }, { id: "z", duration: 1 }], { workers: 3, resources: { gpu: 1 } });
  assert.deepEqual(r.attempts, [A("x", 1, 0, 2), A("z", 1, 0, 1), A("y", 1, 2, 4)]);
  assert.equal(r.makespan, 4);
  const two = simulate([{ id: "x", duration: 2, needs: { mem: 2 } }, { id: "y", duration: 2, needs: { mem: 2 } }, { id: "w", duration: 2, needs: { mem: 4 } }], { workers: 3, resources: { mem: 4 } });
  assert.deepEqual(two.attempts, [A("w", 1, 0, 2), A("x", 1, 2, 4), A("y", 1, 2, 4)]);
});

test("no head-of-line blocking", () => {
  const r = simulate([
    { id: "p", duration: 3, priority: 5, needs: { gpu: 1 } },
    { id: "q", duration: 1, priority: 4, needs: { gpu: 1 } },
    { id: "r", duration: 1, priority: 0 },
  ], { workers: 2, resources: { gpu: 1 } });
  assert.deepEqual(r.attempts, [A("p", 1, 0, 3), A("r", 1, 0, 1), A("q", 1, 3, 4)]);
  assert.equal(r.makespan, 4);
});

test("retries rerun immediately and block dependents until success", () => {
  const r = simulate([{ id: "f", duration: 2, failAttempts: 1, maxRetries: 1 }, { id: "g", duration: 1, deps: ["f"] }], { workers: 1 });
  assert.deepEqual(r.attempts, [A("f", 1, 0, 2, false), A("f", 2, 2, 4), A("g", 1, 4, 5)]);
  assert.equal(r.makespan, 5);
  assert.deepEqual(r.status, { f: "done", g: "done" });
});

test("permanent failure skips transitive dependents only", () => {
  const r = simulate([
    { id: "f", duration: 1, failAttempts: 3, maxRetries: 1 },
    { id: "g", duration: 1, deps: ["f"] },
    { id: "h", duration: 1, deps: ["g"] },
    { id: "k", duration: 1 },
    { id: "m", duration: 1, deps: ["k"] },
  ], { workers: 1 });
  assert.deepEqual(r.status, { f: "failed", g: "skipped", h: "skipped", k: "done", m: "done" });
  assert.deepEqual(r.attempts, [A("f", 1, 0, 1, false), A("f", 2, 1, 2, false), A("k", 1, 2, 3), A("m", 1, 3, 4)]);
  assert.equal(r.makespan, 4);
});

test("failed attempt frees its worker and a higher-priority retry goes first", () => {
  const r = simulate([
    { id: "a", duration: 1, priority: 9, failAttempts: 1, maxRetries: 1 },
    { id: "b", duration: 2 },
    { id: "c", duration: 1, priority: 9 },
  ], { workers: 1 });
  assert.deepEqual(r.attempts, [A("a", 1, 0, 1, false), A("a", 2, 1, 2), A("c", 1, 2, 3), A("b", 1, 3, 5)]);
});

test("two workers finishing together are released before new starts", () => {
  const r = simulate([
    { id: "a", duration: 2 }, { id: "b", duration: 2 }, { id: "c", duration: 1, deps: ["a", "b"] }, { id: "d", duration: 1 },
  ], { workers: 2 });
  assert.deepEqual(r.attempts, [A("a", 1, 0, 2), A("b", 1, 0, 2), A("c", 1, 2, 3), A("d", 1, 2, 3)]);
});

test("empty input and purity", () => {
  assert.deepEqual(simulate([], { workers: 1 }), { makespan: 0, attempts: [], status: {} });
  const jobs = [{ id: "a", duration: 2, deps: [], needs: { r: 1 } }, { id: "b", duration: 1, deps: ["a"] }];
  const copy = structuredClone(jobs);
  const opts = { workers: 2, resources: { r: 1 } };
  const optsCopy = structuredClone(opts);
  const one = simulate(jobs, opts);
  assert.deepEqual(jobs, copy);
  assert.deepEqual(opts, optsCopy);
  assert.deepEqual(simulate(jobs, opts), one);
});

test("validation errors", () => {
  assert.throws(() => simulate([{ id: "a", duration: 1 }, { id: "a", duration: 1 }], { workers: 1 }), /duplicate/);
  assert.throws(() => simulate([{ id: "a", duration: 1, deps: ["nope"] }], { workers: 1 }), /unknown/);
  assert.throws(() => simulate([{ id: "a", duration: 1, deps: ["a"] }], { workers: 1 }), /cycle/);
  const cyc = (() => { try { simulate([{ id: "a", duration: 1, deps: ["c"] }, { id: "b", duration: 1, deps: ["a"] }, { id: "c", duration: 1, deps: ["b"] }, { id: "d", duration: 1 }], { workers: 1 }); } catch (e) { return e; } })();
  assert.ok(cyc instanceof Error && /cycle/.test(cyc.message));
  for (const id of ["a", "b", "c"]) assert.ok(cyc.message.includes(id), `cycle message should list ${id}`);
  assert.throws(() => simulate([{ id: "a", duration: 1, needs: { gpu: 1 } }], { workers: 1, resources: {} }), /unknown resource/);
  assert.throws(() => simulate([{ id: "a", duration: 1, needs: { gpu: 3 } }], { workers: 1, resources: { gpu: 2 } }), RangeError);
  assert.throws(() => simulate([{ id: "a", duration: 1 }], { workers: 0 }), RangeError);
  assert.throws(() => simulate([{ id: "a", duration: 1 }], { workers: 1.5 }), RangeError);
  assert.throws(() => simulate([{ id: "a", duration: 0 }], { workers: 1 }), RangeError);
  assert.throws(() => simulate([{ id: "a", duration: 1.5 }], { workers: 1 }), RangeError);
  assert.throws(() => simulate([{ id: "a", duration: 1, failAttempts: -1 }], { workers: 1 }), RangeError);
  assert.throws(() => simulate([{ id: "a", duration: 1, maxRetries: 0.5 }], { workers: 1 }), RangeError);
});

test("criticalPath", () => {
  assert.deepEqual(criticalPath([]), { length: 0, path: [] });
  assert.deepEqual(criticalPath([{ id: "a", duration: 2 }, { id: "b", duration: 3, deps: ["a"] }, { id: "c", duration: 3, deps: ["a"] }, { id: "d", duration: 1, deps: ["b", "c"] }]), { length: 6, path: ["a", "b", "d"] });
  assert.deepEqual(criticalPath([{ id: "y", duration: 5 }, { id: "x", duration: 5 }]), { length: 5, path: ["x"] });
  assert.deepEqual(criticalPath([{ id: "p", duration: 1 }, { id: "q", duration: 1, deps: ["p"] }, { id: "r", duration: 5 }]), { length: 5, path: ["r"] });
  assert.deepEqual(criticalPath([{ id: "p", duration: 3 }, { id: "q", duration: 3, deps: ["p"] }, { id: "r", duration: 5 }]), { length: 6, path: ["p", "q"] });
  assert.deepEqual(criticalPath([{ id: "a", duration: 1 }, { id: "ab", duration: 1, deps: ["a"] }, { id: "b", duration: 2 }]), { length: 2, path: ["a", "ab"] });
  assert.throws(() => criticalPath([{ id: "a", duration: 1, deps: ["b"] }, { id: "b", duration: 1, deps: ["a"] }]), /cycle/);
  assert.throws(() => criticalPath([{ id: "a", duration: 1 }, { id: "a", duration: 1 }]), /duplicate/);
  assert.throws(() => criticalPath([{ id: "a", duration: 1, deps: ["z"] }]), /unknown/);
});

test("formatGantt", () => {
  const r = simulate([{ id: "a", duration: 2 }, { id: "b", duration: 3, deps: ["a"] }], { workers: 1 });
  assert.equal(formatGantt(r), "a |##...|\nb |..###|");
  const retry = simulate([{ id: "f", duration: 2, failAttempts: 1, maxRetries: 1 }, { id: "g", duration: 1, deps: ["f"] }], { workers: 1 });
  assert.equal(formatGantt(retry), "f |xx##.|\ng |....#|");
  const pad = simulate([{ id: "a", duration: 1 }, { id: "long", duration: 1, deps: ["a"] }], { workers: 1 });
  assert.equal(formatGantt(pad), "a    |#.|\nlong |.#|");
  const skipped = simulate([{ id: "f", duration: 1, failAttempts: 1 }, { id: "g", duration: 1, deps: ["f"] }], { workers: 1 });
  assert.equal(formatGantt(skipped), "f |x|");
  assert.equal(formatGantt({ makespan: 0, attempts: [], status: {} }), "");
});
