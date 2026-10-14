const KEYWORDS = new Set(["SELECT","FROM","WHERE","GROUP","BY","ORDER","ASC","DESC","LIMIT","OFFSET","JOIN","INNER","ON","AS","AND","OR","NOT","IS","NULL","LIKE","IN","COUNT","SUM","MIN","MAX","AVG"]);

function tokenize(sql) {
  const toks = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let s = ""; i++;
      for (;;) {
        if (i >= sql.length) throw new SyntaxError("unterminated string");
        if (sql[i] === "'") { if (sql[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; }
        s += sql[i++];
      }
      toks.push({ t: "str", v: s }); continue;
    }
    if (/\d/.test(c)) { let j = i; while (/\d/.test(sql[j] || "")) j++; toks.push({ t: "num", v: Number(sql.slice(i, j)) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (/[A-Za-z0-9_]/.test(sql[j] || "")) j++;
      const w = sql.slice(i, j), up = w.toUpperCase();
      toks.push(KEYWORDS.has(up) ? { t: "kw", v: up } : { t: "id", v: w }); i = j; continue;
    }
    const two = sql.slice(i, i + 2);
    if (["<=", ">=", "!=", "<>"].includes(two)) { toks.push({ t: "sym", v: two === "<>" ? "!=" : two }); i += 2; continue; }
    if ("(),*.=<>;-".includes(c)) { toks.push({ t: "sym", v: c }); i++; continue; }
    throw new SyntaxError(`unexpected character ${c}`);
  }
  return toks;
}

const refText = (r) => (r.table ? `${r.table}.${r.name}` : r.name);

function parseQuery(sql) {
  const toks = tokenize(sql);
  let p = 0;
  const fail = (m) => { throw new SyntaxError(m); };
  const isKw = (v) => toks[p]?.t === "kw" && toks[p].v === v;
  const isSym = (v) => toks[p]?.t === "sym" && toks[p].v === v;
  const kw = (v) => { if (!isKw(v)) fail(`expected ${v}`); p++; };
  const sym = (v) => { if (!isSym(v)) fail(`expected ${v}`); p++; };
  const acceptKw = (v) => (isKw(v) ? (p++, true) : false);
  const ident = () => { if (toks[p]?.t !== "id") fail("expected identifier"); return toks[p++].v; };
  const colref = () => { const a = ident(); if (isSym(".")) { p++; return { table: a, name: ident() }; } return { name: a }; };
  const literal = () => {
    const t = toks[p];
    if (t?.t === "num" || t?.t === "str") { p++; return { k: "lit", v: t.v }; }
    if (isSym("-") && toks[p + 1]?.t === "num") { p += 2; return { k: "lit", v: -toks[p - 1].v }; }
    if (isKw("NULL")) { p++; return { k: "lit", v: null }; }
    return null;
  };
  const operand = () => literal() ?? (toks[p]?.t === "id" ? { k: "col", ref: colref() } : fail("expected operand"));
  const nonNegInt = () => { if (toks[p]?.t !== "num") fail("expected non-negative integer"); return toks[p++].v; };

  function pred() {
    if (isSym("(")) { p++; const e = expr(); sym(")"); return e; }
    const left = operand();
    for (const op of ["=", "!=", "<=", ">=", "<", ">"]) if (isSym(op)) { p++; return { k: "cmp", op, left, right: operand() }; }
    if (acceptKw("IS")) { const not = acceptKw("NOT"); kw("NULL"); return { k: "isnull", left, not }; }
    let not = false;
    if (isKw("NOT") && toks[p + 1]?.t === "kw" && ["LIKE", "IN"].includes(toks[p + 1].v)) { p++; not = true; }
    if (acceptKw("LIKE")) { if (toks[p]?.t !== "str") fail("expected pattern"); return { k: "like", left, pat: toks[p++].v, not }; }
    if (acceptKw("IN")) {
      sym("(");
      const list = [];
      do { const l = literal(); if (!l) fail("expected literal"); list.push(l.v); } while (isSym(",") && (p++, true));
      sym(")");
      return { k: "in", left, list, not };
    }
    return fail("expected predicate");
  }
  function notExpr() { if (acceptKw("NOT")) return { k: "not", e: notExpr() }; return pred(); }
  function andExpr() { let e = notExpr(); while (acceptKw("AND")) e = { k: "and", a: e, b: notExpr() }; return e; }
  function expr() { let e = andExpr(); while (acceptKw("OR")) e = { k: "or", a: e, b: andExpr() }; return e; }

  kw("SELECT");
  const items = [];
  let star = false;
  if (isSym("*")) { p++; star = true; } else {
    do {
      let item;
      const t = toks[p];
      if (t?.t === "kw" && ["COUNT", "SUM", "MIN", "MAX", "AVG"].includes(t.v)) {
        p++; sym("(");
        let arg;
        if (isSym("*")) { if (t.v !== "COUNT") fail("* only valid in COUNT"); p++; arg = "*"; } else arg = colref();
        sym(")");
        item = { agg: t.v, arg, name: `${t.v.toLowerCase()}(${arg === "*" ? "*" : refText(arg)})` };
      } else { const ref = colref(); item = { ref, name: ref.name }; }
      if (acceptKw("AS")) item.name = ident();
      items.push(item);
    } while (isSym(",") && (p++, true));
  }
  kw("FROM");
  const source = () => { const table = ident(); let alias; if (acceptKw("AS")) alias = ident(); else if (toks[p]?.t === "id") alias = ident(); return { table, alias }; };
  const from = source();
  let join = null;
  if (isKw("INNER")) { p++; kw("JOIN"); join = {}; } else if (acceptKw("JOIN")) join = {};
  if (join) { Object.assign(join, source()); kw("ON"); join.l = colref(); sym("="); join.r = colref(); }
  const where = acceptKw("WHERE") ? expr() : null;
  let groupBy = null;
  if (acceptKw("GROUP")) { kw("BY"); groupBy = colref(); }
  const order = [];
  if (acceptKw("ORDER")) {
    kw("BY");
    do { const ref = colref(); let desc = false; if (acceptKw("DESC")) desc = true; else acceptKw("ASC"); order.push({ ref, desc }); } while (isSym(",") && (p++, true));
  }
  let limit = null, offset = 0;
  if (acceptKw("LIMIT")) { limit = nonNegInt(); if (acceptKw("OFFSET")) offset = nonNegInt(); }
  if (isSym(";")) p++;
  if (p < toks.length) fail("unexpected trailing tokens");
  return { star, items, from, join, where, groupBy, order, limit, offset };
}

function likeRegex(pat) {
  return new RegExp(`^${[...pat].map((c) => (c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "is");
}

function run(tables, sql) {
  const q = parseQuery(sql);
  const sources = [q.from, ...(q.join ? [q.join] : [])].map((s) => {
    const t = tables.get(s.table);
    if (!t) throw new Error(`unknown table: ${s.table}`);
    return { alias: s.alias ?? s.table, t };
  });
  if (new Set(sources.map((s) => s.alias)).size !== sources.length) throw new Error("duplicate alias");
  const resolve = (ref) => {
    if (ref.table) {
      const s = sources.find((x) => x.alias === ref.table);
      if (!s) throw new Error(`unknown table: ${ref.table}`);
      if (!s.t.columns.some((c) => c.name === ref.name)) throw new Error(`unknown column: ${refText(ref)}`);
      return { alias: s.alias, name: ref.name };
    }
    const hits = sources.filter((s) => s.t.columns.some((c) => c.name === ref.name));
    if (hits.length === 0) throw new Error(`unknown column: ${ref.name}`);
    if (hits.length > 1) throw new Error(`ambiguous column: ${ref.name}`);
    return { alias: hits[0].alias, name: ref.name };
  };
  const get = (row, ref) => { const r = resolve(ref); return row[r.alias][r.name]; };

  let combos = sources[0].t.rows.map((r) => ({ [sources[0].alias]: r }));
  if (q.join) {
    const out = [];
    const a = resolve(q.join.l), b = resolve(q.join.r);
    for (const c of combos) for (const r of sources[1].t.rows) {
      const row = { ...c, [sources[1].alias]: r };
      const x = row[a.alias][a.name], y = row[b.alias][b.name];
      if (x !== null && y !== null && x === y) out.push(row);
    }
    combos = out;
  }

  const val = (row, o) => (o.k === "lit" ? o.v : get(row, o.ref));
  const cmp3 = (a, b, op) => {
    if (a === null || b === null) return null;
    if (typeof a !== typeof b) throw new Error("type mismatch");
    return { "=": a === b, "!=": a !== b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b }[op];
  };
  const ev = (row, e) => {
    switch (e.k) {
      case "cmp": return cmp3(val(row, e.left), val(row, e.right), e.op);
      case "isnull": { const n = val(row, e.left) === null; return e.not ? !n : n; }
      case "like": { const v = val(row, e.left); if (v === null) return null; if (typeof v !== "string") throw new Error("type mismatch"); const m = likeRegex(e.pat).test(v); return e.not ? !m : m; }
      case "in": {
        const v = val(row, e.left);
        if (v === null) return null;
        let unknown = false, hit = false;
        for (const x of e.list) { if (x === null) unknown = true; else if (typeof x !== typeof v) throw new Error("type mismatch"); else if (x === v) hit = true; }
        const r = hit ? true : unknown ? null : false;
        return e.not ? (r === null ? null : !r) : r;
      }
      case "not": { const r = ev(row, e.e); return r === null ? null : !r; }
      case "and": { const a = ev(row, e.a), b = ev(row, e.b); return a === false || b === false ? false : a === null || b === null ? null : true; }
      case "or": { const a = ev(row, e.a), b = ev(row, e.b); return a === true || b === true ? true : a === null || b === null ? null : false; }
    }
  };
  if (q.where) combos = combos.filter((r) => ev(r, q.where) === true);

  const cmpVals = (a, b) => (a === null && b === null ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0);
  let names, rows;
  const aggMode = q.items.some((i) => i.agg) || q.groupBy;
  if (!aggMode) {
    let outItems;
    if (q.star) {
      outItems = [];
      for (const s of sources) for (const c of s.t.columns) outItems.push({ key: sources.length > 1 ? `${s.alias}.${c.name}` : c.name, alias: s.alias, col: c.name });
    } else outItems = q.items.map((i) => { const r = resolve(i.ref); return { key: i.name, alias: r.alias, col: r.name }; });
    names = outItems.map((o) => o.key);
    rows = combos.map((c) => ({ out: Object.fromEntries(outItems.map((o) => [o.key, c[o.alias][o.col]])), src: c }));
  } else {
    if (q.star) throw new Error("invalid select item");
    const g = q.groupBy ? resolve(q.groupBy) : null;
    for (const i of q.items) if (!i.agg) { const r = resolve(i.ref); if (!g || r.alias !== g.alias || r.name !== g.name) throw new Error("invalid select item"); }
    const groups = new Map();
    if (g) for (const c of combos) { const k = c[g.alias][g.name]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); } else groups.set("all", combos);
    names = q.items.map((i) => i.name);
    rows = [...groups.values()].map((grp) => {
      const out = {};
      for (const i of q.items) {
        if (!i.agg) { out[i.name] = get(grp[0], i.ref); continue; }
        if (i.arg === "*") { out[i.name] = grp.length; continue; }
        const vs = grp.map((c) => get(c, i.arg)).filter((v) => v !== null);
        if (i.agg === "COUNT") out[i.name] = vs.length;
        else if (i.agg === "MIN" || i.agg === "MAX") out[i.name] = vs.length ? vs.reduce((m, v) => ((i.agg === "MIN" ? v < m : v > m) ? v : m)) : null;
        else {
          if (vs.some((v) => typeof v !== "number")) throw new Error("type mismatch");
          const s = vs.reduce((a, b) => a + b, 0);
          out[i.name] = vs.length ? (i.agg === "SUM" ? s : s / vs.length) : null;
        }
      }
      return { out, src: grp[0] };
    });
  }

  if (q.order.length) {
    const keyFor = q.order.map((o) => {
      if (!o.ref.table && names.includes(o.ref.name)) return (r) => r.out[o.ref.name];
      resolve(o.ref);
      return (r) => { if (!r.src) throw new Error(`unknown column: ${refText(o.ref)}`); return get(r.src, o.ref); };
    });
    rows = rows.map((r, i) => ({ r, i })).sort((x, y) => {
      for (let k = 0; k < q.order.length; k++) {
        const c = cmpVals(keyFor[k](x.r), keyFor[k](y.r));
        if (c) return q.order[k].desc ? -c : c;
      }
      return x.i - y.i;
    }).map((x) => x.r);
  }
  const end = q.limit === null ? undefined : q.offset + q.limit;
  return rows.slice(q.offset, end).map((r) => ({ ...r.out }));
}

export function createDb() {
  const tables = new Map();
  return {
    createTable(name, columns) {
      if (tables.has(name)) throw new Error(`table exists: ${name}`);
      if (!Array.isArray(columns) || columns.length === 0) throw new Error("columns required");
      const seen = new Set();
      for (const c of columns) {
        if (c.type !== "int" && c.type !== "text") throw new TypeError(`bad type: ${c.type}`);
        if (seen.has(c.name)) throw new Error(`duplicate column: ${c.name}`);
        seen.add(c.name);
      }
      tables.set(name, { columns: columns.map((c) => ({ ...c })), rows: [] });
    },
    insert(name, row) {
      const t = tables.get(name);
      if (!t) throw new Error(`unknown table: ${name}`);
      for (const k of Object.keys(row)) if (!t.columns.some((c) => c.name === k)) throw new Error(`unknown column: ${k}`);
      const out = {};
      for (const c of t.columns) {
        const v = row[c.name] ?? null;
        if (v !== null && (c.type === "int" ? !Number.isInteger(v) : typeof v !== "string")) throw new TypeError(`bad value for ${c.name}`);
        out[c.name] = v;
      }
      t.rows.push(out);
    },
    query: (sql) => run(tables, sql),
  };
}
