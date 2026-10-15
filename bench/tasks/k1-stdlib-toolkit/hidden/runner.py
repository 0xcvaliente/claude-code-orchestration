"""Sandbox child: runs one adapter's cases against a toolkit solution.

Usage: python3 -I -B runner.py SOL_ROOT ADAPTER_PATH CASES_JSON START

Protocol (one JSON object per line on the original stdout):
  {"event": "ready"}                      solution module imported
  {"fatal": "..."}                        import failed; nothing else follows
  {"i": n, "event": "start"}              case n started
  {"i": n, "r": <result>}                 run_impl returned
  {"i": n, "status": "timeout"|"exception"|"badresult", "msg": "..."}
"""
import builtins
import importlib.abc
import importlib.util
import json
import os
import signal
import sys

CASE_LIMIT_S = 2.0
IMPORT_LIMIT_S = 10

BLOCK = {
    "re", "sre_compile", "sre_parse", "sre_constants", "_sre", "tomllib", "csv", "_csv",
    "shlex", "fnmatch", "glob", "textwrap", "string", "subprocess", "ctypes", "sqlite3",
    "socket", "multiprocessing", "importlib",
}

sol, adapter_path, cases_path, start = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
sol = os.path.realpath(sol)
TOOLKIT_DIR = os.path.join(sol, "toolkit") + os.sep
RUNNER_FILE = os.path.realpath(__file__)
IMPORTLIB_DIR = os.path.dirname(os.path.realpath(importlib.util.__file__)) + os.sep

# Protocol channel: a private copy of stdout. The solution's prints go to /dev/null.
proto = os.fdopen(os.dup(1), "w", buffering=1)
devnull = os.open(os.devnull, os.O_WRONLY)
os.dup2(devnull, 1)
sys.stdout = open(os.devnull, "w")


def emit(obj):
    proto.write(json.dumps(obj) + "\n")
    proto.flush()


with open(cases_path, encoding="utf-8") as f:
    cases = json.load(f)

spec = importlib.util.spec_from_file_location("_k1_adapter", adapter_path)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def inside_toolkit(path):
    if not path:
        return False
    try:
        return os.path.realpath(path).startswith(TOOLKIT_DIR)
    except (TypeError, ValueError):
        return False


def blocked_msg(name):
    return f"import of {name!r} from the solution is not allowed"


class Blocker(importlib.abc.MetaPathFinder):
    """Refuses blocked modules when the code doing the import lives in toolkit/."""

    def find_spec(self, name, path, target=None):
        if name.split(".")[0] not in BLOCK:
            return None
        frame = sys._getframe(1)
        while frame is not None:
            fn = frame.f_code.co_filename
            if fn.startswith("<frozen importlib") or os.path.realpath(fn) == RUNNER_FILE or fn.startswith(IMPORTLIB_DIR):
                frame = frame.f_back
                continue
            if inside_toolkit(fn):
                raise ImportError(blocked_msg(name))
            return None
        return None


_orig_import = builtins.__import__


def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    # Catches imports of modules that are already cached in sys.modules,
    # which never reach the meta-path finder.
    if level == 0 and name.split(".")[0] in BLOCK and globals is not None:
        if inside_toolkit(globals.get("__file__")):
            raise ImportError(blocked_msg(name))
    return _orig_import(name, globals, locals, fromlist, level)


# sys.path: the standard library first (so a solution cannot shadow it), then the solution root.
sys.path[:] = [p for p in sys.path if "site-packages" not in p and "dist-packages" not in p] + [sol]
sys.meta_path.insert(0, Blocker())
builtins.__import__ = guarded_import


class Timeout(BaseException):
    pass


def on_alarm(signum, frame):
    raise Timeout()


signal.signal(signal.SIGALRM, on_alarm)

try:
    signal.alarm(IMPORT_LIMIT_S)
    mod = importlib.import_module(adapter.MODULE)
    signal.alarm(0)
except BaseException as e:  # noqa: BLE001
    signal.alarm(0)
    emit({"fatal": f"import of {adapter.MODULE} failed: {type(e).__name__}: {e}"[:500]})
    sys.exit(0)

emit({"event": "ready"})

for i in range(start, len(cases)):
    emit({"i": i, "event": "start"})
    try:
        signal.setitimer(signal.ITIMER_REAL, CASE_LIMIT_S)
        try:
            res = adapter.run_impl(mod, cases[i])
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
    except Timeout:
        emit({"i": i, "status": "timeout", "msg": f"exceeded {CASE_LIMIT_S}s"})
        continue
    except BaseException as e:  # noqa: BLE001
        emit({"i": i, "status": "exception", "msg": f"{type(e).__name__}: {e}"[:300]})
        continue
    try:
        line = json.dumps({"i": i, "r": res})
    except (TypeError, ValueError) as e:
        emit({"i": i, "status": "badresult", "msg": f"result not JSON-serializable: {e}"[:300]})
        continue
    proto.write(line + "\n")
    proto.flush()
