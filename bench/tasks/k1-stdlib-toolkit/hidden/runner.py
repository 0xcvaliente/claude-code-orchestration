"""Sandbox child: runs one adapter's cases against a toolkit solution.

Usage: python3 -I -S -B runner.py SOL_ROOT ADAPTER_PATH CASES_MARSHAL START MODULE NAME

Startup order matters: nothing that imports `re` is loaded before the solution
module (no json, no importlib.abc, no site), and the oracle modules tomllib,
shlex, csv and _csv cannot be imported by anyone in this process.

Protocol on the original stdout: frames of a 4-byte big-endian length plus a
marshal-encoded dict:
  {"event": "ready"}                      solution module imported
  {"fatal": "..."}                        import failed; nothing else follows
  {"flag": "stdlib-oracle-used:<mod>"}    solution code reached an oracle module
  {"i": n, "event": "start"}              case n started
  {"i": n, "r": <result>}                 run_impl returned
  {"i": n, "status": "timeout"|"exception"|"badresult", "msg": "..."}
"""
import builtins
import importlib.util
import marshal
import os
import signal
import sys

CASE_LIMIT_S = 2.0
IMPORT_LIMIT_S = 10

# Refused when the importing code lives in the solution's toolkit/ dir.
BLOCK = {
    "re", "sre_compile", "sre_parse", "sre_constants", "_sre", "tomllib", "csv", "_csv",
    "shlex", "fnmatch", "glob", "textwrap", "string", "subprocess", "ctypes", "sqlite3",
    "socket", "multiprocessing", "importlib",
}
# Refused for every importer in this process: no honest solution needs them, even transitively.
STRICT = {"tomllib", "shlex", "csv", "_csv"}
# Categories during whose cases the `re` engine is watched.
RE_WATCH_CATS = {"regex"}

sol, adapter_path, cases_path, start, module_name, cat = (
    sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5], sys.argv[6])
sol = os.path.realpath(sol)
TOOLKIT_DIR = os.path.join(sol, "toolkit") + os.sep
RUNNER_FILE = os.path.realpath(__file__)
IMPORTLIB_DIR = os.path.dirname(os.path.realpath(importlib.util.__file__)) + os.sep

# Protocol channel: a private copy of stdout. The solution's prints go to /dev/null.
proto = os.fdopen(os.dup(1), "wb", buffering=0)
devnull = os.open(os.devnull, os.O_WRONLY)
os.dup2(devnull, 1)
sys.stdout = open(os.devnull, "w")


def emit(obj):
    data = marshal.dumps(obj)
    proto.write(len(data).to_bytes(4, "big") + data)


with open(cases_path, "rb") as f:
    cases = marshal.load(f)

STATE = {"in_case": False, "flagged": set()}


def inside_toolkit(path):
    if not path:
        return False
    try:
        return os.path.realpath(path).startswith(TOOLKIT_DIR)
    except (TypeError, ValueError):
        return False


def toolkit_on_stack(depth=2):
    try:
        frame = sys._getframe(depth)
    except ValueError:
        return False
    while frame is not None:
        if inside_toolkit(frame.f_code.co_filename):
            return True
        frame = frame.f_back
    return False


def flag_oracle(modname):
    key = "stdlib-oracle-used:" + modname
    if key not in STATE["flagged"]:
        STATE["flagged"].add(key)
        emit({"flag": key})


def blocked_msg(name):
    return f"import of {name!r} is not allowed here"


class Blocker:
    """Meta-path finder: STRICT modules for everyone, BLOCK modules for toolkit code."""

    def find_spec(self, name, path, target=None):
        top = name.split(".")[0]
        if top in STRICT:
            if toolkit_on_stack():
                flag_oracle(top)
            raise ImportError(blocked_msg(name))
        if top not in BLOCK:
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
    # Catches imports of modules already cached in sys.modules, which never reach the finder.
    if level == 0:
        top = name.split(".")[0]
        if top in STRICT:
            if toolkit_on_stack():
                flag_oracle(top)
            raise ImportError(blocked_msg(name))
        if top in BLOCK and globals is not None and inside_toolkit(globals.get("__file__")):
            raise ImportError(blocked_msg(name))
    return _orig_import(name, globals, locals, fromlist, level)


def purge_strict():
    for m in list(sys.modules):
        if m.split(".")[0] in STRICT:
            del sys.modules[m]


# ---- oracle watch: wrappers on the real modules' entry points ----
WATCH = {
    "tomllib": ["loads", "load"],
    "shlex": ["split", "quote", "join", "shlex"],
    "csv": ["reader", "writer", "DictReader", "DictWriter", "Sniffer"],
    "_csv": ["reader", "writer"],
}
RE_FUNCS = ["compile", "search", "match", "fullmatch", "split", "findall", "finditer",
            "sub", "subn", "escape", "_compile"]
_wrapped = {}


def _make_wrapper(modname, orig, watch_always):
    def wrapper(*args, **kwargs):
        if (watch_always or cat in RE_WATCH_CATS) and STATE["in_case"] and toolkit_on_stack():
            flag_oracle(modname)
        return orig(*args, **kwargs)
    return wrapper


def wrap_attr(mod, attr, modname, watch_always=True):
    key = (id(mod), attr)
    if key in _wrapped:
        return
    orig = getattr(mod, attr, None)
    if orig is None:
        return
    if isinstance(orig, type):
        _wrapped[key] = orig
        return  # classes: covered by the import block; leave them intact
    try:
        setattr(mod, attr, _make_wrapper(modname, orig, watch_always))
        _wrapped[key] = orig
    except (AttributeError, TypeError):
        pass


def install_watch():
    for modname, attrs in WATCH.items():
        m = sys.modules.get(modname)
        if m is not None:
            for a in attrs:
                wrap_attr(m, a, modname)
    if cat in RE_WATCH_CATS:
        re_mod = sys.modules.get("re")
        if re_mod is not None:
            for a in RE_FUNCS:
                wrap_attr(re_mod, a, "re", watch_always=False)
            comp = getattr(re_mod, "_compiler", None)
            if comp is not None:
                wrap_attr(comp, "compile", "re", watch_always=False)
            try:
                re_mod.purge()  # force recompilation so captured references reach _sre.compile
            except Exception:  # noqa: BLE001
                pass
        sre = sys.modules.get("_sre")
        if sre is not None:
            wrap_attr(sre, "compile", "re", watch_always=False)


# ---- audit hook: the oracle modules' source files may not be read, compiled or run by solution code ----
STDLIB_DIR = os.path.dirname(os.path.realpath(os.__file__))
_SEP = os.sep
ORACLE_PATHS = [  # (prefix of a realpath, oracle module)
    (os.path.join(STDLIB_DIR, "tomllib") + _SEP, "tomllib"),
    (os.path.join(STDLIB_DIR, "shlex.py"), "shlex"),
    (os.path.join(STDLIB_DIR, "__pycache__", "shlex."), "shlex"),
    (os.path.join(STDLIB_DIR, "csv.py"), "csv"),
    (os.path.join(STDLIB_DIR, "__pycache__", "csv."), "csv"),
    (os.path.join(STDLIB_DIR, "re") + _SEP, "re"),
]
AUDIT_EVENTS = {"open", "compile", "exec", "import"}
_audit_busy = [False]


def _oracle_of(path):
    if path is None or isinstance(path, int):
        return None
    try:
        p = os.fspath(path)
        if isinstance(p, bytes):
            p = os.fsdecode(p)
        if not p or p.startswith("<"):
            return None
        rp = os.path.realpath(p)
    except Exception:  # noqa: BLE001
        return None
    for prefix, modname in ORACLE_PATHS:
        if rp.startswith(prefix) or rp == prefix:
            return modname
    return None


def _importing_re_by_name():
    """True when the import machinery is loading the real `re` package under its own name."""
    frame = sys._getframe(2)
    while frame is not None:
        if frame.f_code.co_name in ("_find_and_load", "_load_unlocked", "_find_and_load_unlocked"):
            name = frame.f_locals.get("name")
            if name is None:
                spec_ = frame.f_locals.get("spec")
                name = getattr(spec_, "name", None)
            if isinstance(name, str):
                return name == "re" or name.startswith("re.")
        frame = frame.f_back
    return False


def audit(event, args):
    if event not in AUDIT_EVENTS or _audit_busy[0]:
        return
    _audit_busy[0] = True
    try:
        if event == "open":
            target = args[0] if args else None
        elif event == "compile":
            target = args[1] if len(args) > 1 else None
        elif event == "exec":
            target = getattr(args[0], "co_filename", None) if args else None
        else:  # import: (module, filename, sys.path, sys.meta_path, sys.path_hooks)
            target = args[1] if len(args) > 1 else None
        modname = _oracle_of(target)
        if modname is None:
            return
        if modname == "re" and (cat not in RE_WATCH_CATS or _importing_re_by_name()):
            return  # the stdlib loading `re` normally; regex solutions are also watched via _sre
        if not toolkit_on_stack(depth=2):
            return
        flag_oracle(modname)
        raise PermissionError(f"solution code may not use the {modname} sources")
    finally:
        _audit_busy[0] = False


sys.addaudithook(audit)

# sys.path: the standard library first (so a solution cannot shadow it), then the solution root.
sys.path[:] = [p for p in sys.path if "site-packages" not in p and "dist-packages" not in p] + [sol]
purge_strict()
sys.meta_path.insert(0, Blocker())
builtins.__import__ = guarded_import


class Timeout(BaseException):
    pass


def on_alarm(signum, frame):
    raise Timeout()


signal.signal(signal.SIGALRM, on_alarm)

# 1. The solution module, before anything that loads `re`.
try:
    signal.alarm(IMPORT_LIMIT_S)
    mod = importlib.import_module(module_name)
    signal.alarm(0)
except BaseException as e:  # noqa: BLE001
    signal.alarm(0)
    emit({"fatal": f"import of {module_name} failed: {type(e).__name__}: {e}"[:500]})
    sys.exit(0)

# 2. The adapter (it may import json, random, ...).
spec = importlib.util.spec_from_file_location("_k1_adapter", adapter_path)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
purge_strict()

emit({"event": "ready"})

for i in range(start, len(cases)):
    emit({"i": i, "event": "start"})
    install_watch()
    try:
        STATE["in_case"] = True
        signal.setitimer(signal.ITIMER_REAL, CASE_LIMIT_S)
        try:
            res = adapter.run_impl(mod, cases[i])
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            STATE["in_case"] = False
    except Timeout:
        emit({"i": i, "status": "timeout", "msg": f"exceeded {CASE_LIMIT_S}s"})
        continue
    except BaseException as e:  # noqa: BLE001
        emit({"i": i, "status": "exception", "msg": f"{type(e).__name__}: {e}"[:300]})
        continue
    try:
        emit({"i": i, "r": res})
    except (TypeError, ValueError) as e:
        emit({"i": i, "status": "badresult", "msg": f"result not serializable: {e}"[:300]})
