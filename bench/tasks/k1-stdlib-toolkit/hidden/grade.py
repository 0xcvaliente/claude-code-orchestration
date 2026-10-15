"""Grade a toolkit solution differentially against the Python 3.13 standard library.

Usage: grade.py SOLUTION_DIR [--out results.json] [--only toml,shlex] [-v]

SOLUTION_DIR must contain the toolkit/ package. Every hidden/mod_*.py adapter is
discovered automatically. For each adapter, run_impl runs in a sandboxed child
(runner.py: python3 -I, stdlib + solution root on sys.path, import blocker,
2 s per case) and run_oracle runs here; results are compared with same().
SOLUTION_DIR is never modified.
"""
import argparse
import glob
import importlib.util
import json
import os
import select
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, "runner.py")
CASE_LIMIT_S = 2.0
HARD_GRACE_S = 3.0
IMPORT_LIMIT_S = 15.0
STATIC_PATTERNS = ["__import__", "importlib", "sys.modules", "eval(", "exec(", "builtins"]


def load_adapters(only=None):
    adapters, flags = [], []
    for path in sorted(glob.glob(os.path.join(HERE, "mod_*.py"))):
        try:
            spec = importlib.util.spec_from_file_location("_k1_" + os.path.basename(path)[:-3], path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if only and mod.NAME not in only:
                continue
            cases = list(mod.cases())
            ids = [c["id"] for c in cases]
            if len(set(ids)) != len(ids):
                raise ValueError("duplicate case ids")
            adapters.append({"path": path, "mod": mod, "name": mod.NAME, "cases": cases})
        except Exception as e:  # noqa: BLE001
            flags.append(f"adapter error: {os.path.basename(path)}: {type(e).__name__}: {e}"[:300])
    return adapters, flags


def oracle_results(ad):
    out = []
    for c in ad["cases"]:
        try:
            r = ad["mod"].run_oracle(c)
        except Exception as e:  # noqa: BLE001
            r = {"oracle_crash": f"{type(e).__name__}: {e}"}
        out.append(json.loads(json.dumps(r)))
    return out


def run_module(sol, ad):
    """Run every case of one adapter in sandboxed children; return {index: record}."""
    cases = ad["cases"]
    n = len(cases)
    results = {}
    fd, cases_path = tempfile.mkstemp(suffix=".json", prefix="k1-cases-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cases, f)
    i = 0
    try:
        while i < n:
            start_i = i
            p = subprocess.Popen(
                [sys.executable, "-I", "-B", RUNNER, sol, ad["path"], cases_path, str(i)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                cwd=tempfile.gettempdir(), bufsize=0,
            )
            out_fd = p.stdout.fileno()
            buf = b""
            current, started, spawned, ready = None, time.time(), time.time(), False
            done = False
            while not done:
                readable, _, _ = select.select([out_fd], [], [], 0.2)
                if readable:
                    chunk = os.read(out_fd, 65536)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        try:
                            msg = json.loads(line)
                        except ValueError:
                            continue
                        if "fatal" in msg:
                            for j in range(i, n):
                                results[j] = {"status": "import_failed", "msg": msg["fatal"]}
                            i = n
                            done = True
                            break
                        if msg.get("event") == "ready":
                            ready = True
                        elif msg.get("event") == "start":
                            current, started = msg["i"], time.time()
                        elif "i" in msg:
                            results[msg["i"]] = msg
                            current, i = None, msg["i"] + 1
                    continue
                now = time.time()
                if not ready and now - spawned > IMPORT_LIMIT_S:
                    for j in range(i, n):
                        results[j] = {"status": "import_failed", "msg": "import timed out"}
                    i = n
                    break
                if current is not None and now - started > CASE_LIMIT_S + HARD_GRACE_S:
                    results[current] = {"status": "timeout", "msg": "hard timeout (child killed)"}
                    i = current + 1
                    current = None
                    break
            p.kill()
            p.wait()
            p.stdout.close()
            if current is not None and current not in results:
                results[current] = {"status": "crash", "msg": "child exited during the case"}
                i = current + 1
            elif i < n and i == start_i:
                results[i] = {"status": "crash", "msg": "child exited without running the case"}
                i += 1
    finally:
        os.unlink(cases_path)
    return results


def compare(ad, expected, got):
    same = getattr(ad["mod"], "same", None) or (lambda a, b: a == b)
    per_case = {}
    passed = 0
    for idx, c in enumerate(ad["cases"]):
        exp = expected[idx]
        rec = got.get(idx, {"status": "missing"})
        if "r" in rec:
            try:
                ok = bool(same(exp, rec["r"]))
            except Exception:  # noqa: BLE001
                ok = False
            detail = "ok" if ok else f"expected {json.dumps(exp)[:200]} got {json.dumps(rec['r'])[:200]}"
        else:
            ok = False
            detail = f"{rec.get('status')}: {rec.get('msg', '')}"
        passed += ok
        per_case[c["id"]] = {"pass": ok, "detail": detail[:420]}
    return passed, per_case


def static_scan(sol):
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
            for pat in STATIC_PATTERNS:
                if pat in src:
                    flags.append(f"static: {pat} in {rel}")
    return flags, sloc


def grade(sol, only=None):
    sol = os.path.abspath(sol)
    adapters, flags = load_adapters(only)
    expected = {ad["name"]: oracle_results(ad) for ad in adapters}
    with ThreadPoolExecutor(max_workers=max(1, len(adapters))) as ex:
        futs = {ad["name"]: ex.submit(run_module, sol, ad) for ad in adapters}
        got = {name: f.result() for name, f in futs.items()}
    out = {"solution": sol, "by_cat": {}, "cases": {}, "modules": {}}
    for ad in adapters:
        passed, per_case = compare(ad, expected[ad["name"]], got[ad["name"]])
        out["by_cat"][ad["name"]] = [passed, len(ad["cases"])]
        out["cases"].update(per_case)
        failed_import = [r for r in got[ad["name"]].values() if r.get("status") == "import_failed"]
        out["modules"][ad["name"]] = failed_import[0]["msg"] if failed_import else "ok"
    out["passed"] = sum(p for p, _ in out["by_cat"].values())
    out["total"] = sum(t for _, t in out["by_cat"].values())
    out["pct"] = round(100.0 * out["passed"] / out["total"], 1) if out["total"] else 0.0
    sflags, sloc = static_scan(sol)
    out["flags"] = flags + sflags
    out["sloc"] = sloc
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("solution")
    ap.add_argument("--out")
    ap.add_argument("--only", help="comma-separated category names")
    ap.add_argument("-v", action="store_true")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    out = grade(a.solution, only)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=1)
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
