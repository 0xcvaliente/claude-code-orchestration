"""Grade a toolkit solution differentially against the Python 3.13 standard library.

Usage: grade.py SOLUTION_DIR [--out results.json] [--only toml,shlex] [-v]

SOLUTION_DIR must contain the toolkit/ package. Every hidden/mod_*.py adapter is
discovered automatically and checked against hidden/modules.json (expected
categories and case counts; a null count means "whatever the adapter has").
Each adapter declares NAME, MODULE, ORACLES (the stdlib modules it reimplements)
and WRAP (oracle entry points to watch); the sandbox and the oracle flag ->
category mapping are built from those, so a module plugs in without edits here. For each adapter, run_impl runs in a sandboxed
child (runner.py: python3 -I -S -B, stdlib + solution root on sys.path, import
blocker, oracle watch, 2 s per case) and run_oracle runs here; results are
compared with same(). SOLUTION_DIR is never modified.

Budgets per module: 10 s to import per child spawn (past that the module's
remaining cases fail), 5 timed-out cases (then the remaining cases fail without
running), 5 crashes, and MODULE_WALL_S of wall time. --out is rewritten after
every finished module, so a killed grader still leaves the finished modules.
"""
import argparse
import glob
import importlib.util
import json
import marshal
import os
import select
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, "runner.py")
CASE_LIMIT_S = 2.0
HARD_GRACE_S = 3.0
IMPORT_LIMIT_S = 12.0   # parent watchdog; the child's own import alarm is 10 s
TIMEOUT_BUDGET = 5
CRASH_BUDGET = 5
MODULE_WALL_S = 600.0
BASE_STATIC_PATTERNS = ["__import__", "importlib", "sys.modules", "eval(", "exec(", "builtins",
                        "runpy", "shutil.copy", "copytree", "copyfile", "sysconfig", "get_path", ".__file__",
                        # rebuilding a watch-only oracle's functions from their code objects
                        "__code__", "FunctionType", "_strptime", "vars("]
ORACLE_FLAG = "stdlib-oracle-used:"      # an oracle was reached: zeroes this module and the oracle's
REFUSED_FLAG = "stdlib-oracle-refused:"  # an oracle import was refused: zeroes this module only
ZERO_FLAGS = (ORACLE_FLAG, REFUSED_FLAG)


def expected_modules(hidden_dir=HERE):
    with open(os.path.join(hidden_dir, "modules.json"), encoding="utf-8") as f:
        return json.load(f)


def _str_list(mod, attr, check):
    v = getattr(mod, attr, None)
    if not isinstance(v, (list, tuple)) or not all(isinstance(x, str) and check(x) for x in v):
        raise ValueError(f"{attr} must be a list of module names" if attr == "ORACLES"
                         else f"{attr} must be a list of '<module>.<name>' strings")
    return list(v)


def load_adapters(hidden_dir=HERE):
    adapters, errors = {}, []
    for path in sorted(glob.glob(os.path.join(hidden_dir, "mod_*.py"))):
        try:
            spec = importlib.util.spec_from_file_location("_k2_" + os.path.basename(path)[:-3], path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            oracles = _str_list(mod, "ORACLES", lambda x: bool(x) and x.replace(".", "").replace("_", "").isalnum())
            if not oracles:
                raise ValueError("ORACLES is empty")
            wrap = _str_list(mod, "WRAP", lambda x: "." in x)
            watch_only = getattr(mod, "WATCH_ONLY", False)
            if not isinstance(watch_only, bool):
                raise ValueError("WATCH_ONLY must be True or False")
            callers = _str_list(mod, "WATCH_CALLERS", bool) if hasattr(mod, "WATCH_CALLERS") else []
            if callers and not watch_only:
                raise ValueError("WATCH_CALLERS needs WATCH_ONLY = True")
            cases = list(mod.cases())
            ids = [c["id"] for c in cases]
            if len(set(ids)) != len(ids):
                raise ValueError("duplicate case ids")
            adapters[mod.NAME] = {"path": path, "mod": mod, "name": mod.NAME, "cases": cases,
                                  "oracles": oracles, "wrap": wrap, "watch_only": watch_only,
                                  "watch_callers": callers}
        except Exception as e:  # noqa: BLE001
            errors.append(f"grader error: adapter {os.path.basename(path)} failed to load: {type(e).__name__}: {e}"[:300])
    return adapters, errors


def _jsonable(r):
    return json.loads(json.dumps(r))


def oracle_results(ad):
    out = []
    for c in ad["cases"]:
        try:
            r = _jsonable(ad["mod"].run_oracle(c))
        except Exception as e:  # noqa: BLE001
            r = {"oracle_crash": f"{type(e).__name__}: {e}"}
        out.append(r)
    return out


def oracle_category(adapters):
    """Oracle module named in a stdlib-oracle-used flag -> the category it serves."""
    return {m: name for name, ad in adapters.items() for m in ad["oracles"]}


def static_patterns(adapters):
    """{pattern: files exempt from it}: an oracle's patterns do not fire in the file of the module
    that reimplements it (cal.py may say "calendar"); every other file is scanned for them."""
    pats = {p: set() for p in BASE_STATIC_PATTERNS}
    for ad in adapters.values():
        own = os.path.join(*ad["mod"].MODULE.split(".")) + ".py"
        for m in ad["oracles"]:
            mp = []
            if len(m) >= 4 and not m.startswith("_"):
                mp += [f"'{m}'", f'"{m}"']
            if "." not in m and len(m) >= 3 and not m.startswith("_"):
                mp.append(f"{m}.py")
            for p in mp:
                if p in BASE_STATIC_PATTERNS:
                    continue
                if p not in pats:
                    pats[p] = {own}
                else:
                    pats[p] &= {own}  # two modules sharing an oracle pattern: exempt neither
    return pats


def run_module(sol, ad, oracles_by_cat, wrap_by_cat, watch_only=(), watch_callers=None):
    """Run every case of one adapter in sandboxed children; return ({index: record}, flags)."""
    cases = ad["cases"]
    n = len(cases)
    results, flags = {}, set()
    timeouts = crashes = 0
    t_module = time.time()
    # The job goes to each child over its stdin pipe: no job file a solution could find on disk.
    job = marshal.dumps({"cases": cases, "oracles": oracles_by_cat, "wrap": wrap_by_cat,
                         "watch_only": list(watch_only), "watch_callers": dict(watch_callers or {})})

    def fail_rest(frm, why):
        for j in range(frm, n):
            results.setdefault(j, {"status": "skipped", "msg": why})

    i = 0
    try:
        while i < n:
            if time.time() - t_module > MODULE_WALL_S:
                fail_rest(i, f"module time budget ({MODULE_WALL_S:.0f}s) exhausted")
                break
            start_i = i
            p = subprocess.Popen(
                [sys.executable, "-I", "-S", "-B", RUNNER, sol, ad["path"], "-", str(i),
                 ad["mod"].MODULE, ad["name"]],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.PIPE,
                cwd=tempfile.gettempdir(), bufsize=0,
            )
            try:  # the child reads all of stdin before it runs any solution code
                p.stdin.write(job)
            except OSError:
                pass
            finally:
                try:
                    p.stdin.close()
                except OSError:
                    pass
            out_fd = p.stdout.fileno()
            buf = b""
            current, started, spawned, ready = None, time.time(), time.time(), False
            stop = False
            while not stop:
                readable, _, _ = select.select([out_fd], [], [], 0.2)
                if readable:
                    chunk = os.read(out_fd, 65536)
                    if not chunk:
                        break
                    buf += chunk
                    while len(buf) >= 4 and not stop:
                        size = int.from_bytes(buf[:4], "big")
                        if len(buf) < 4 + size:
                            break
                        try:
                            msg = marshal.loads(buf[4:4 + size])
                        except Exception:  # noqa: BLE001
                            msg = None
                        buf = buf[4 + size:]
                        if not isinstance(msg, dict):
                            continue
                        if "fatal" in msg:
                            fail_rest(i, str(msg["fatal"]))
                            for j in range(i, n):
                                results[j] = {"status": "import_failed", "msg": str(msg["fatal"])}
                            i, stop = n, True
                        elif "flag" in msg:
                            flags.add(str(msg["flag"]))
                        elif msg.get("event") == "ready":
                            ready = True
                        elif msg.get("event") == "start":
                            current, started = msg.get("i"), time.time()
                        elif isinstance(msg.get("i"), int):
                            results[msg["i"]] = msg
                            current, i = None, msg["i"] + 1
                            if msg.get("status") == "timeout":
                                timeouts += 1
                                if timeouts >= TIMEOUT_BUDGET:
                                    fail_rest(i, f"timeout budget ({TIMEOUT_BUDGET} timed-out cases) exhausted")
                                    i, stop = n, True
                    continue
                now = time.time()
                if not ready and now - spawned > IMPORT_LIMIT_S:
                    for j in range(i, n):
                        results[j] = {"status": "import_failed", "msg": "import timed out"}
                    i = n
                    break
                if current is not None and now - started > CASE_LIMIT_S + HARD_GRACE_S:
                    results[current] = {"status": "timeout", "msg": "hard timeout (child killed)"}
                    i, current = current + 1, None
                    timeouts += 1
                    if timeouts >= TIMEOUT_BUDGET:
                        fail_rest(i, f"timeout budget ({TIMEOUT_BUDGET} timed-out cases) exhausted")
                        i = n
                    break
                if now - t_module > MODULE_WALL_S + CASE_LIMIT_S + HARD_GRACE_S:
                    break
            p.kill()
            p.wait()
            p.stdout.close()
            if i >= n:
                break
            if current is not None and current not in results:
                results[current] = {"status": "crash", "msg": "child exited during the case"}
                i = current + 1
                crashes += 1
            elif i == start_i:
                results[i] = {"status": "crash", "msg": "child exited without running the case"}
                i += 1
                crashes += 1
            if crashes >= CRASH_BUDGET:
                fail_rest(i, f"crash budget ({CRASH_BUDGET}) exhausted")
                break
    finally:
        job = None  # drop the job bytes
    return results, flags


def compare(ad, expected, got, flags):
    same = getattr(ad["mod"], "same", None) or (lambda a, b: a == b)
    oracle_used = sorted(f for f in flags if f.startswith(ZERO_FLAGS))
    per_case, passed = {}, 0
    for idx, c in enumerate(ad["cases"]):
        exp = expected[idx]
        rec = got.get(idx, {"status": "missing"})
        if oracle_used:
            ok, detail = False, "module scored 0: " + ", ".join(oracle_used)
        elif "r" in rec:
            try:
                r = _jsonable(rec["r"])
                ok = bool(same(exp, r))
                detail = "ok" if ok else f"expected {json.dumps(exp)[:200]} got {json.dumps(r)[:200]}"
            except Exception as e:  # noqa: BLE001
                ok, detail = False, f"badresult: {type(e).__name__}: {e}"
        else:
            ok, detail = False, f"{rec.get('status')}: {rec.get('msg', '')}"
        passed += ok
        per_case[c["id"]] = {"pass": ok, "detail": detail[:420]}
    return passed, per_case


def static_scan(sol, patterns=BASE_STATIC_PATTERNS):
    """patterns: a list, or {pattern: files (relative to SOLUTION_DIR) exempt from it}."""
    if not isinstance(patterns, dict):
        patterns = {p: set() for p in patterns}
    flags, sloc = [], 0
    root = os.path.join(sol, "toolkit")
    if not os.path.isdir(root):
        return ["missing toolkit/ package"], 0
    for dirpath, _, files in os.walk(root):
        for fn in sorted(files):
            if not fn.endswith(".py"):
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, sol)
            with open(path, encoding="utf-8", errors="replace") as f:
                src = f.read()
            sloc += sum(1 for ln in src.splitlines() if ln.strip() and not ln.strip().startswith("#"))
            for pat, exempt in patterns.items():
                if pat in src and rel not in exempt:
                    flags.append(f"static: {pat} in {rel}")
    return flags, sloc


def grade(sol, only=None, out_path=None, hidden_dir=HERE):
    """hidden_dir: where modules.json and the mod_*.py adapters live (the selftest passes its own)."""
    sol = os.path.abspath(sol)
    expected_counts = expected_modules(hidden_dir)
    adapters, flags = load_adapters(hidden_dir)
    oracles_by_cat = {name: ad["oracles"] for name, ad in adapters.items()}
    wrap_by_cat = {name: ad["wrap"] for name, ad in adapters.items()}
    # Oracles of adapters declaring WATCH_ONLY = True stay importable (the runner adds re itself).
    watch_only = sorted({m for ad in adapters.values() if ad["watch_only"] for m in ad["oracles"]})
    # Stdlib modules whose genuine calls into a watch-only oracle are not solution use (cal: _strptime).
    watch_callers = {m: list(ad["watch_callers"]) for ad in adapters.values() if ad["watch_callers"]
                     for m in ad["oracles"]}
    oracle_cat = oracle_category(adapters)
    cats = {}  # name -> {"passed", "total", "cases", "status", "done"}
    for name, count in expected_counts.items():
        ad = adapters.get(name)
        if count is None and ad is not None:
            count = len(ad["cases"])
        cats[name] = {"passed": 0, "total": count or 0, "cases": {}, "status": "not finished", "done": False}
        if ad is None:
            if count is None:
                flags.append(f"grader error: no adapter loaded for {name} (case count unknown)")
            else:
                flags.append(f"adapter missing for {name}: its {count} tests fail")
            cats[name].update(status="adapter missing", done=True)
        elif len(ad["cases"]) != count:
            flags.append(f"grader error: {name} has {len(ad['cases'])} cases, modules.json expects {count}")
            cats[name].update(status="case count mismatch", done=True)
            del adapters[name]
    for name, ad in adapters.items():
        if name not in cats:
            flags.append(f"grader error: {name} is not listed in modules.json")
            cats[name] = {"passed": 0, "total": len(ad["cases"]), "cases": {}, "status": "not finished", "done": False}
    if only:
        cats = {k: v for k, v in cats.items() if k in only}
        adapters = {k: v for k, v in adapters.items() if k in only}
    sflags, sloc = static_scan(sol, static_patterns(adapters))
    lock = threading.Lock()

    def build():
        out = {"solution": sol, "by_cat": {}, "cases": {}, "modules": {}}
        for name, c in cats.items():
            out["by_cat"][name] = [c["passed"], c["total"]]
            out["cases"].update(c["cases"])
            out["modules"][name] = c["status"]
        out["passed"] = sum(p for p, _ in out["by_cat"].values())
        out["total"] = sum(t for _, t in out["by_cat"].values())
        out["pct"] = round(100.0 * out["passed"] / out["total"], 1) if out["total"] else 0.0
        oracle = sorted({f"{f} ({name})" for name, c in cats.items() for f in c.get("flags", ())})
        out["flags"] = flags + oracle + sflags
        out["sloc"] = sloc
        out["complete"] = all(c["done"] for c in cats.values())
        return out

    def write():
        if out_path:
            tmp = out_path + ".tmp"
            # Per-case details (which quote expected results) stay out of the file: other modules'
            # solution code is still running while it exists.
            summary = {k: v for k, v in build().items() if k != "cases"}
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(summary, f, indent=1)
            os.replace(tmp, out_path)

    def work(ad):
        name = ad["name"]
        try:
            expected = oracle_results(ad)
            got, mflags = run_module(sol, ad, oracles_by_cat, wrap_by_cat, watch_only, watch_callers)
            passed, per_case = compare(ad, expected, got, mflags)
            failed_import = [r for r in got.values() if r.get("status") == "import_failed"]
            status = failed_import[0]["msg"] if failed_import else "ok"
            oracle = sorted(f for f in mflags if f.startswith(ZERO_FLAGS))
            if oracle:
                status = "scored 0: " + ", ".join(oracle)
            with lock:
                cats[name].update(passed=passed, cases=per_case, status=status, done=True, flags=oracle)
                write()
        except Exception as e:  # noqa: BLE001
            with lock:
                flags.append(f"grader error: {name}: {type(e).__name__}: {e}"[:300])
                cats[name].update(status="grader error", done=True)
                write()

    write()
    with ThreadPoolExecutor(max_workers=max(1, len(adapters))) as ex:
        list(ex.map(work, adapters.values()))
    # An oracle use raised while grading one module also zeroes the module that oracle serves.
    # A refused import reached nothing, so it zeroes only the module that tried it.
    with lock:
        for name, c in list(cats.items()):
            for f in c.get("flags", ()):
                if not f.startswith(ORACLE_FLAG):
                    continue
                target = oracle_cat.get(f[len(ORACLE_FLAG):])
                if target in cats and target != name and cats[target]["passed"]:
                    t = cats[target]
                    t["passed"] = 0
                    t["status"] = f"scored 0: {f} (raised while grading {name})"
                    for cid in t["cases"]:
                        t["cases"][cid] = {"pass": False, "detail": t["status"]}
    out = build()
    write()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("solution")
    ap.add_argument("--out")
    ap.add_argument("--only", help="comma-separated category names")
    ap.add_argument("-v", action="store_true")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    out = grade(a.solution, only, a.out)
    for cat, (p, t) in out["by_cat"].items():
        status = out["modules"][cat]
        print(f"  {cat:8s} {p:4d}/{t:4d}" + ("" if status == "ok" else f"  ({status[:120]})"))
    print(f"TOTAL {out['passed']}/{out['total']} ({out['pct']}%)  sloc={out['sloc']}  flags={out['flags']}")
    if a.v:
        for cid, r in out["cases"].items():
            if not r["pass"]:
                print("FAIL", cid, r["detail"][:300])


if __name__ == "__main__":
    main()
