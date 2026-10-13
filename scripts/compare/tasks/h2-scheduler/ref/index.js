const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function normalize(jobs) {
  const seen = new Set();
  const out = jobs.map((j) => {
    if (seen.has(j.id)) throw new Error(`duplicate id: ${j.id}`);
    seen.add(j.id);
    return { id: j.id, duration: j.duration, deps: [...(j.deps ?? [])], priority: j.priority ?? 0, needs: { ...(j.needs ?? {}) }, failAttempts: j.failAttempts ?? 0, maxRetries: j.maxRetries ?? 0 };
  });
  for (const j of out) for (const d of j.deps) if (!seen.has(d)) throw new Error(`unknown dependency: ${d} (needed by ${j.id})`);
  const byId = new Map(out.map((j) => [j.id, j]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const cyc = stack.slice(stack.indexOf(id));
      throw new Error(`cycle: ${[...cyc, id].join(" -> ")}`);
    }
    state.set(id, 1); stack.push(id);
    for (const d of byId.get(id).deps) visit(d);
    stack.pop(); state.set(id, 2);
  };
  for (const j of out) visit(j.id);
  return out;
}

const isPosInt = (n) => Number.isInteger(n) && n > 0;
const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;

export function simulate(jobs, options) {
  const list = normalize(jobs);
  const { workers, resources = {} } = options ?? {};
  if (!isPosInt(workers)) throw new RangeError("workers must be a positive integer");
  for (const j of list) {
    if (!isPosInt(j.duration)) throw new RangeError(`bad duration for ${j.id}`);
    if (!isNonNegInt(j.failAttempts) || !isNonNegInt(j.maxRetries)) throw new RangeError(`bad retry settings for ${j.id}`);
    for (const [r, n] of Object.entries(j.needs)) {
      if (!(r in resources)) throw new Error(`unknown resource: ${r}`);
      if (!isPosInt(n) || n > resources[r]) throw new RangeError(`bad need ${r} for ${j.id}`);
    }
  }
  const st = new Map(list.map((j) => [j.id, { j, status: "pending", attempt: 0 }]));
  const avail = { ...resources };
  let free = workers;
  const running = [];
  const attempts = [];
  let t = 0;
  for (;;) {
    for (const r of running.filter((x) => x.end === t).sort((a, b) => cmpStr(a.id, b.id))) {
      running.splice(running.indexOf(r), 1);
      free++;
      for (const [k, n] of Object.entries(st.get(r.id).j.needs)) avail[k] += n;
      const s = st.get(r.id);
      if (r.ok) s.status = "done";
      else if (s.attempt < 1 + s.j.maxRetries) s.status = "pending";
      else {
        s.status = "failed";
        let changed = true;
        while (changed) {
          changed = false;
          for (const o of st.values()) if (o.status === "pending" && o.j.deps.some((d) => ["failed", "skipped"].includes(st.get(d).status))) { o.status = "skipped"; changed = true; }
        }
      }
    }
    const ready = [...st.values()].filter((s) => s.status === "pending" && s.j.deps.every((d) => st.get(d).status === "done"))
      .sort((a, b) => b.j.priority - a.j.priority || cmpStr(a.j.id, b.j.id));
    for (const s of ready) {
      if (free < 1) break;
      if (!Object.entries(s.j.needs).every(([k, n]) => avail[k] >= n)) continue;
      free--;
      for (const [k, n] of Object.entries(s.j.needs)) avail[k] -= n;
      s.attempt++;
      s.status = "running";
      const ok = s.attempt > s.j.failAttempts;
      const a = { id: s.j.id, attempt: s.attempt, start: t, end: t + s.j.duration, ok };
      attempts.push(a);
      running.push(a);
    }
    if (!running.length) break;
    t = Math.min(...running.map((r) => r.end));
  }
  attempts.sort((a, b) => a.start - b.start || cmpStr(a.id, b.id) || a.attempt - b.attempt);
  const status = {};
  for (const s of st.values()) status[s.j.id] = s.status;
  return { makespan: attempts.reduce((m, a) => Math.max(m, a.end), 0), attempts, status };
}

export function criticalPath(jobs) {
  const list = normalize(jobs);
  const byId = new Map(list.map((j) => [j.id, j]));
  const memo = new Map();
  const best = (id) => {
    if (memo.has(id)) return memo.get(id);
    const j = byId.get(id);
    let top = { length: 0, path: [] };
    for (const d of j.deps) {
      const c = best(d);
      if (c.length > top.length || (c.length === top.length && lexLess(c.path, top.path))) top = c;
    }
    const res = { length: top.length + j.duration, path: [...top.path, id] };
    memo.set(id, res);
    return res;
  };
  let result = { length: 0, path: [] };
  for (const j of list) {
    const c = best(j.id);
    if (c.length > result.length || (c.length === result.length && lexLess(c.path, result.path))) result = c;
  }
  return result;
}

function lexLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i];
  return a.length < b.length;
}

export function formatGantt(result) {
  const ids = [...new Set(result.attempts.map((a) => a.id))].sort(cmpStr);
  if (!ids.length) return "";
  const w = Math.max(...ids.map((i) => i.length));
  return ids.map((id) => {
    const cells = Array.from({ length: result.makespan }, (_, u) => {
      const cover = result.attempts.filter((a) => a.id === id && a.start <= u && u < a.end);
      return cover.some((a) => a.ok) ? "#" : cover.length ? "x" : ".";
    });
    return `${id.padEnd(w)} |${cells.join("")}|`;
  }).join("\n");
}
