"""Sandbox child: runs one adapter's cases against a toolkit solution.

Usage: python3 -I -S -B runner.py SOL_ROOT ADAPTER_PATH - START MODULE NAME

The job arrives on stdin (marshal, read in full before anything else runs; no
file on disk): {"cases": [...], "oracles": {category: [module, ...]},
"wrap": {category: ["<module>.<name>", ...]}}: every loaded adapter's ORACLES
(the stdlib modules it reimplements) and WRAP (oracle entry points to watch).
Everything the sandbox refuses or watches is derived from those lists plus a
fixed base list, so a new module plugs in by declaring ORACLES and WRAP.

In every child, whatever category it grades (k1 parity: one child must not
compute answers for another category's module, e.g. through webbrowser.shlex):
  - Every category's oracles, except WATCH_ONLY, may not be imported by anyone
    in this process; an attempt with toolkit code on the stack is flagged as a
    use of that oracle, which zeroes the category the oracle belongs to.
  - Toolkit code may not import any oracle, nor the BASE_BLOCK modules.
  - Wrappers on every category's WRAP entry points, and an audit hook on every
    oracle's source files, flag toolkit code that reaches them.
  - Spawning processes and hard links (os.system, os.posix_spawn, os.exec*,
    os.fork, os.spawn*, os.link) are refused while toolkit code is on the stack.
WATCH_ONLY modules (re and the sre_* shims) are imported all over the standard
library, so they stay importable; they are watched only while the cases of the
category that owns them (regex) run, as in k1.
Known limit, the same as k1: `re` laundering between children is not detected:
code in another category's child may compute regex answers with the real `re`
(outside regex cases) and hand them over.

Startup order matters: nothing that imports `re` is loaded before the solution
module (no json, no importlib.abc, no site, no adapter).

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

# Refused for toolkit code in every category, whatever the adapters declare.
BASE_BLOCK = ["subprocess", "ctypes", "sqlite3", "socket", "multiprocessing", "importlib"]
# Imported by much of the standard library (json, dataclasses, inspect, ...): these oracles stay
# importable and are watched (wrappers, audit) during their own category's cases instead.
WATCH_ONLY = {"re", "sre_compile", "sre_parse", "sre_constants", "_sre"}
# Audit events refused while toolkit code is on the stack (event name, or prefix ending in ".").
REFUSED_EVENTS = {"os.system", "os.posix_spawn", "os.exec", "os.fork", "os.forkpty", "os.spawn",
                  "os.link", "subprocess.Popen", "pty.spawn"}

sol, adapter_path, _stdin_marker, start, module_name, cat = (
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


def _read_job():
    chunks = []
    while True:
        b = os.read(0, 1 << 20)
        if not b:
            break
        chunks.append(b)
    nul = os.open(os.devnull, os.O_RDONLY)
    os.dup2(nul, 0)
    os.close(nul)
    return marshal.loads(b"".join(chunks))


job = _read_job()
cases = job["cases"]
ORACLES_BY_CAT = {str(k): [str(m) for m in v] for k, v in job["oracles"].items()}
WRAP_BY_CAT = {str(k): [str(w) for w in v] for k, v in job.get("wrap", {}).items()}
del job
ALL_ORACLES = sorted({m for mods in ORACLES_BY_CAT.values() for m in mods})
OWN = set(ORACLES_BY_CAT.get(cat, []))

BLOCK = set(BASE_BLOCK) | set(ALL_ORACLES)              # refused for toolkit code
STRICT = {m for m in ALL_ORACLES if m not in WATCH_ONLY}  # refused for every importer

STATE = {"in_case": False, "flagged": set()}


def _matches(name, mods):
    """The module in `mods` that `name` is, or is a submodule of; None if none."""
    for m in mods:
        if name == m or name.startswith(m + "."):
            return m
    return None


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


ADAPTER_DIR = os.path.dirname(os.path.realpath(adapter_path)) + os.sep


def adapter_on_stack(depth=2):
    """True when an adapter's own code (a file in the adapter's dir other than this runner) is on the stack."""
    try:
        frame = sys._getframe(depth)
    except ValueError:
        return False
    while frame is not None:
        fn = frame.f_code.co_filename
        if fn and not fn.startswith("<"):
            try:
                rp = os.path.realpath(fn)
            except (TypeError, ValueError):
                rp = ""
            if rp.startswith(ADAPTER_DIR) and rp != RUNNER_FILE:
                return True
        frame = frame.f_back
    return False


def strict_refused(hit):
    """A strict oracle import: flagged and refused with toolkit code on the stack; allowed for the
    adapter's own code (bookkeeping, run_oracle); refused for anything else (threads, callbacks)."""
    if toolkit_on_stack(depth=3):
        flag_oracle(hit)
        return True
    return not adapter_on_stack(depth=3)


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
        hit = _matches(name, STRICT)
        if hit is not None:
            if strict_refused(hit):
                raise ImportError(blocked_msg(name))
            return None
        if _matches(name, BLOCK) is None:
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
        names = [name] + [f"{name}.{x}" for x in (fromlist or ()) if isinstance(x, str)]
        for n in names:
            hit = _matches(n, STRICT)
            if hit is not None and strict_refused(hit):
                raise ImportError(blocked_msg(n))
        if globals is not None and inside_toolkit(globals.get("__file__")):
            for n in names:
                if _matches(n, BLOCK) is not None:
                    raise ImportError(blocked_msg(n))
    return _orig_import(name, globals, locals, fromlist, level)


def purge_strict():
    for m in list(sys.modules):
        if _matches(m, STRICT) is not None:
            del sys.modules[m]


# ---- oracle watch: wrappers on this category's WRAP entry points ----
_wrapped = {}


def _active(modname):
    """Strict oracles are watched always; WATCH_ONLY ones only during their own category's cases."""
    if modname in WATCH_ONLY:
        return STATE["in_case"] and modname in OWN
    return True


def _make_wrapper(modname, orig):
    def wrapper(*args, **kwargs):
        if _active(modname) and toolkit_on_stack():
            flag_oracle(modname)
        return orig(*args, **kwargs)
    return wrapper


def _wrap_function(owner, attr, modname):
    key = (id(owner), attr)
    if key in _wrapped:
        return
    if isinstance(owner, type):
        orig = owner.__dict__.get(attr)
        if not callable(orig) or isinstance(orig, (type, staticmethod, classmethod)):
            return  # only plain functions defined on the class are wrapped
    else:
        orig = getattr(owner, attr, None)
        if orig is None or isinstance(orig, type):
            return
    try:
        setattr(owner, attr, _make_wrapper(modname, orig))
        _wrapped[key] = orig
    except (AttributeError, TypeError):
        pass


def _resolve_wrap(entry):
    """'<module>.<attr>[.<attr>]': (owner object, last attr, module name) or None if not loaded."""
    parts = entry.split(".")
    for k in range(len(parts) - 1, 0, -1):
        modname = ".".join(parts[:k])
        obj = sys.modules.get(modname)
        if obj is None:
            continue
        for a in parts[k:-1]:
            obj = getattr(obj, a, None)
            if obj is None:
                return None
        return obj, parts[-1], modname
    return None


def install_watch():
    for entry in (w for ws in WRAP_BY_CAT.values() for w in ws):
        hit = _resolve_wrap(entry)
        if hit is None:
            continue
        owner, attr, modname = hit
        tag = _matches(modname, ALL_ORACLES) or modname
        target = owner.__dict__.get(attr) if isinstance(owner, type) else getattr(owner, attr, None)
        if isinstance(target, type):
            for a, v in list(vars(target).items()):  # a class: wrap its plain methods
                if callable(v) and not isinstance(v, (type, staticmethod, classmethod)):
                    _wrap_function(target, a, tag)
        else:
            _wrap_function(owner, attr, tag)
    # Clear oracle caches (re.purge) so cached compilations go through the wrapped entry points.
    for m in sorted(OWN & WATCH_ONLY):
        mod = sys.modules.get(m)
        purge = getattr(mod, "purge", None) if mod is not None else None
        if callable(purge):
            try:
                purge()
            except Exception:  # noqa: BLE001
                pass


# ---- audit hook: this category's oracle sources may not be read, compiled or run by solution code ----
def _oracle_paths(mods):
    """(realpath prefix, module) pairs: a package's dir, or a module's file and its __pycache__ entries."""
    out = []
    for m in mods:
        try:
            spec = importlib.util.find_spec(m)
        except Exception:  # noqa: BLE001
            spec = None
        if spec is None:
            continue
        locs = list(spec.submodule_search_locations or [])
        if locs:
            for loc in locs:
                out.append((os.path.realpath(loc) + os.sep, m))
            continue
        origin = spec.origin
        if not origin or not os.path.isabs(origin):
            continue  # built-in modules have no source
        rp = os.path.realpath(origin)
        out.append((rp, m))
        stem = os.path.basename(rp).split(".")[0]
        out.append((os.path.join(os.path.dirname(rp), "__pycache__", stem + "."), m))
    return out


ORACLE_PATHS = _oracle_paths(ALL_ORACLES)
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


def _importing_by_name(mod):
    """True when the import machinery is loading the real `mod` (or a submodule) under its own name."""
    frame = sys._getframe(2)
    while frame is not None:
        if frame.f_code.co_name in ("_find_and_load", "_load_unlocked", "_find_and_load_unlocked"):
            name = frame.f_locals.get("name")
            if name is None:
                spec_ = frame.f_locals.get("spec")
                name = getattr(spec_, "name", None)
            if isinstance(name, str):
                return name == mod or name.startswith(mod + ".")
        frame = frame.f_back
    return False


def _refused(event):
    return event in REFUSED_EVENTS or any(event.startswith(e) for e in ("os.exec", "os.spawn"))


def audit(event, args):
    if _audit_busy[0]:
        return
    if event not in AUDIT_EVENTS:
        if _refused(event):
            _audit_busy[0] = True
            try:
                on_stack = toolkit_on_stack(depth=2)
            finally:
                _audit_busy[0] = False
            if on_stack:
                raise PermissionError(f"{event} is not allowed in solution code")
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
        if modname in WATCH_ONLY and (modname not in OWN or _importing_by_name(modname)):
            return  # the stdlib loading a watch-only module normally
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

# 2. The adapter (it may import json, random, ...; never its own oracles outside run_oracle).
spec = importlib.util.spec_from_file_location("_k2_adapter", adapter_path)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
install_watch()  # wrap any oracle the adapter loaded before it leaves sys.modules
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
