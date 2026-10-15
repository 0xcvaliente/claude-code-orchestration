"""Child process: runs cases against a minisql solution. Usage: runner.py SOL_DIR CASES_PKL START"""
import importlib.abc
import json
import pickle
import signal
import sys
import time

sol, cases_path, start = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(cases_path, "rb") as f:
    cases = pickle.load(f)

BLOCK = {"sqlite3", "_sqlite3", "ctypes", "_ctypes", "subprocess", "_posixsubprocess", "multiprocessing", "dbm"}
ALLOWED = set(sys.stdlib_module_names) - BLOCK


class Blocker(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        top = name.split(".")[0]
        if top == "minisql":
            return None
        if top not in ALLOWED:
            raise ImportError(f"import of {name!r} is not allowed")
        return None


for m in list(sys.modules):
    if m.split(".")[0] in BLOCK:
        del sys.modules[m]
sys.meta_path.insert(0, Blocker())
sys.path.insert(0, sol)


class Timeout(BaseException):
    pass


def on_alarm(signum, frame):
    raise Timeout()


signal.signal(signal.SIGALRM, on_alarm)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


try:
    signal.alarm(20)
    import minisql
    signal.alarm(0)
    if not isinstance(minisql.Error, type) or not issubclass(minisql.Error, Exception):
        raise TypeError("minisql.Error is not an Exception subclass")
except BaseException as e:  # noqa: BLE001
    emit({"fatal": f"import failed: {type(e).__name__}: {e}"[:500]})
    sys.exit(0)

OK_TYPES = (type(None), int, float, str, bool)


def run_case(c):
    try:
        signal.alarm(c["setup_timeout"])
        db = minisql.connect()
        for s in c["stmts"]:
            optional = s.startswith("?")
            try:
                db.execute(s[1:] if optional else s)
            except minisql.Error:
                if not optional:
                    raise
    except Timeout:
        return {"status": "timeout", "phase": "setup"}
    except BaseException as e:  # noqa: BLE001
        return {"status": "setup_error", "msg": f"{type(e).__name__}: {e}"[:300]}
    finally:
        signal.alarm(0)
    t0 = time.perf_counter()
    try:
        signal.alarm(c["query_timeout"])
        out = db.execute(c["sql"])
    except Timeout:
        return {"status": "timeout", "phase": "query"}
    except minisql.Error as e:
        return {"status": "error", "msg": str(e)[:300], "secs": time.perf_counter() - t0}
    except BaseException as e:  # noqa: BLE001
        return {"status": "exception", "msg": f"{type(e).__name__}: {e}"[:300]}
    finally:
        signal.alarm(0)
    secs = time.perf_counter() - t0
    if not isinstance(out, list) or any(not isinstance(r, tuple) for r in out):
        return {"status": "badtype", "msg": f"returned {type(out).__name__}: {repr(out)[:200]}"}
    if any(not isinstance(v, OK_TYPES) for r in out for v in r):
        return {"status": "badtype", "msg": f"bad value type in {repr(out)[:200]}"}
    return {"status": "ok", "rows": [list(r) for r in out], "secs": secs}


for i in range(start, len(cases)):
    emit({"i": i, "event": "start"})
    res = run_case(cases[i])
    res["i"] = i
    emit(res)
