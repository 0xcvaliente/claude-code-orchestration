"""Grade a minisql solution against the hidden suite.

Usage: grade.py SOLUTION_DIR [--out results.json] [--validate] [--cats perf,fuzz] [-v]
SOLUTION_DIR must contain the minisql/ package.
"""
import argparse
import hashlib
import json
import math
import os
import pickle
import select
import sqlite3
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cases import build_cases  # noqa: E402

SETUP_TIMEOUT = 60


def sql_literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return repr(v)


def statements(case, reverse=False):
    out = []
    for name, (create, rows) in case["tables"].items():
        out.append(create)
        rows = list(reversed(rows)) if reverse else list(rows)
        for i in range(0, len(rows), 1000):
            chunk = rows[i:i + 1000]
            out.append(f"INSERT INTO {name} VALUES " + ", ".join("(" + ", ".join(sql_literal(v) for v in r) + ")" for r in chunk))
    out.extend(case["setup"])
    return out


def run_sqlite(case, reverse=False):
    con = sqlite3.connect(":memory:", isolation_level=None)
    for s in statements(case, reverse):
        if s.startswith("?"):
            try:
                con.execute(s[1:])
            except sqlite3.Error:
                pass
        else:
            con.execute(s)
    try:
        return ("rows", [tuple(r) for r in con.execute(case["sql"]).fetchall()])
    except sqlite3.Error as e:
        return ("error", str(e))


def norm(v):
    return int(v) if isinstance(v, bool) else v


def val_eq(a, b):
    a, b = norm(a), norm(b)
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    try:
        return math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-6)
    except TypeError:
        return False


def row_eq(r1, r2):
    return len(r1) == len(r2) and all(val_eq(a, b) for a, b in zip(r1, r2))


def sort_key(row):
    k = []
    for v in row:
        v = norm(v)
        if v is None:
            k.append((0, 0.0, ""))
        elif isinstance(v, (int, float)):
            k.append((1, round(float(v), 6), ""))
        else:
            k.append((2, 0.0, str(v)))
    return k


def res_eq(exp, got, ordered):
    if len(exp) != len(got):
        return False
    if not ordered:
        exp, got = sorted(exp, key=sort_key), sorted(got, key=sort_key)
    return all(row_eq(a, b) for a, b in zip(exp, got))


def top_level_order_by(sql):
    depth, outer = 0, []
    for ch in sql:
        depth += ch == "("
        if depth == 0:
            outer.append(ch)
        depth -= ch == ")"
    return "ORDER BY" in " ".join("".join(outer).upper().split())


def expected_all(cases):
    key = hashlib.sha256(pickle.dumps([(c["id"], c["sql"], c["setup"], sorted(c["tables"])) for c in cases])).hexdigest()[:16]
    path = os.path.join(HERE, f"expected-{key}.pkl")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return pickle.load(f)
    exp = {}
    for c in cases:
        fwd = run_sqlite(c)
        if fwd[0] == "error":
            exp[c["id"]] = {"kind": "error", "msg": fwd[1]}
            continue
        rev = run_sqlite(c, reverse=True)
        ordered = (top_level_order_by(c["sql"]) and rev[0] == "rows" and len(fwd[1]) > 1
                   and res_eq(fwd[1], rev[1], True))
        exp[c["id"]] = {"kind": "rows", "rows": fwd[1], "ordered": ordered,
                        "deterministic": rev[0] == "rows" and res_eq(fwd[1], rev[1], False)}
    with open(path, "wb") as f:
        pickle.dump(exp, f)
    return exp


def validate(cases, exp):
    bad = 0
    for c in cases:
        e = exp[c["id"]]
        if c["expect_error"] and e["kind"] != "error":
            print("NOT AN ERROR IN SQLITE:", c["id"], c["sql"][:100]); bad += 1
        if not c["expect_error"] and e["kind"] == "error":
            print("SQLITE ERROR:", c["id"], c["sql"][:100], "->", e["msg"]); bad += 1
        if e["kind"] == "rows" and not e["deterministic"]:
            print("NONDETERMINISTIC:", c["id"], c["sql"][:100]); bad += 1
    n_ord = sum(1 for e in exp.values() if e.get("ordered"))
    print(f"validated {len(cases)} cases: {bad} problems, {n_ord} order-checked")
    return bad


def run_solution(sol, cases):
    child_cases = [{"stmts": statements(c), "sql": c["sql"], "setup_timeout": SETUP_TIMEOUT,
                    "query_timeout": c["query_timeout"]} for c in cases]
    fd, pkl = tempfile.mkstemp(suffix=".pkl")
    with os.fdopen(fd, "wb") as f:
        pickle.dump(child_cases, f)
    results = {}
    i = 0
    try:
        while i < len(cases):
            p = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "runner.py"), sol, pkl, str(i)],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=tempfile.gettempdir())
            current, started, spawned = None, time.time(), time.time()
            while True:
                ready, _, _ = select.select([p.stdout], [], [], 1.0)
                if ready:
                    line = p.stdout.readline()
                    if not line:
                        break
                    msg = json.loads(line)
                    if "fatal" in msg:
                        for j in range(i, len(cases)):
                            results[j] = {"status": "import_failed", "msg": msg["fatal"]}
                        i = len(cases)
                        break
                    if msg.get("event") == "start":
                        current, started = msg["i"], time.time()
                        continue
                    results[msg["i"]] = msg
                    current, i = None, msg["i"] + 1
                else:
                    now = time.time()
                    if current is not None and now - started > SETUP_TIMEOUT + child_cases[current]["query_timeout"] + 15:
                        results[current] = {"status": "timeout", "phase": "hard"}
                        i = current + 1
                        break
                    if current is None and now - spawned > 60 and not results:
                        for j in range(i, len(cases)):
                            results[j] = {"status": "import_failed", "msg": "import hang"}
                        i = len(cases)
                        break
            p.kill()
            p.wait()
            if current is not None and current not in results:
                results[current] = {"status": "crash"}
                i = current + 1
    finally:
        os.unlink(pkl)
    return results


def static_flags(sol):
    flags = []
    sloc = 0
    for root, _, files in os.walk(os.path.join(sol, "minisql")):
        for fn in files:
            if fn.endswith(".py"):
                src = open(os.path.join(root, fn), encoding="utf-8", errors="replace").read()
                sloc += sum(1 for line in src.splitlines() if line.strip() and not line.strip().startswith("#"))
                import re as _re
                if _re.search(r"^\s*(import|from)\s+(sqlite3|_sqlite3|ctypes|subprocess)\b|__import__|importlib", src, _re.M):
                    flags.append(f"suspicious import: {fn}")
    return flags, sloc


def grade(sol, cases, exp):
    res = run_solution(sol, cases)
    out = {"solution": sol, "cases": {}, "by_cat": {}}
    for idx, c in enumerate(cases):
        r, e = res.get(idx, {"status": "missing"}), exp[c["id"]]
        if e["kind"] == "error":
            ok = r["status"] == "error"
            detail = "ok" if ok else f"expected minisql.Error, got {r['status']}: {r.get('msg') or r.get('rows')}"
        else:
            ok = r["status"] == "ok" and res_eq(e["rows"], [tuple(x) for x in r["rows"]], e["ordered"])
            if ok:
                detail = "ok"
            elif r["status"] == "ok":
                detail = f"expected {e['rows'][:8]!r}, got {r['rows'][:8]!r}"
            else:
                detail = f"{r['status']}: {r.get('msg', r.get('phase', ''))}"
        out["cases"][c["id"]] = {"pass": ok, "detail": str(detail)[:400], "secs": r.get("secs")}
        bc = out["by_cat"].setdefault(c["cat"], [0, 0])
        bc[0] += ok
        bc[1] += 1
    out["passed"] = sum(v[0] for v in out["by_cat"].values())
    out["total"] = len(cases)
    out["pct"] = round(100.0 * out["passed"] / out["total"], 1)
    out["flags"], out["sloc"] = static_flags(sol)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("solution", nargs="?")
    ap.add_argument("--out")
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--cats")
    ap.add_argument("-v", action="store_true")
    ap.add_argument("--suite", default="main", choices=["main", "stress"])
    a = ap.parse_args()
    if a.suite == "stress":
        import cases_stress
        all_cases = cases_stress.build_cases()
    else:
        all_cases = build_cases()
    cases = list(all_cases)
    if a.cats:
        cases = [c for c in cases if c["cat"] in a.cats.split(",")]
    exp = expected_all(all_cases)
    if a.validate:
        sys.exit(1 if validate(cases, exp) else 0)
    out = grade(os.path.abspath(a.solution), cases, exp)
    if a.out:
        with open(a.out, "w") as f:
            json.dump(out, f, indent=1)
    for cat, (p, t) in out["by_cat"].items():
        print(f"  {cat:14s} {p:3d}/{t:3d}")
    print(f"TOTAL {out['passed']}/{out['total']} ({out['pct']}%)  sloc={out['sloc']}  flags={out['flags']}")
    if a.v:
        for cid, r in out["cases"].items():
            if not r["pass"]:
                print("FAIL", cid, r["detail"][:300])


if __name__ == "__main__":
    main()
