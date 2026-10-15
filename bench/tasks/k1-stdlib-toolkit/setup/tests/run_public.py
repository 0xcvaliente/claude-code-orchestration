"""Run the public examples: python3 tests/run_public.py [name ...]

Discovers tests/public_*.py. Each file defines EXAMPLES (a list; dict items may
carry a "name") and one way to check an example against the standard library:
  check(example) -> bool | (bool, detail)      preferred
  run_impl(example) and run_oracle(example)    results compared with ==
or EXAMPLES items that are callables returning bool | (bool, detail).
A check that raises fails that example only. Exit status 0 iff every example passes.
A missing public file simply has nothing to run.
"""
import glob
import importlib.util
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.dont_write_bytecode = True


def _verdict(v):
    if isinstance(v, tuple):
        return bool(v[0]), (str(v[1]) if len(v) > 1 else "")
    return bool(v), ""


def _check_one(mod, ex):
    if hasattr(mod, "check"):
        return _verdict(mod.check(ex))
    if hasattr(mod, "run_impl") and hasattr(mod, "run_oracle"):
        exp, got = mod.run_oracle(ex), mod.run_impl(ex)
        return exp == got, f"expected {exp!r}, got {got!r}"
    if callable(ex):
        return _verdict(ex())
    raise TypeError("public file defines no check(example)")


def _name(ex, i):
    if isinstance(ex, dict):
        return str(ex.get("name") or ex.get("id") or i)
    return getattr(ex, "__name__", str(i))


def main(argv):
    files = sorted(glob.glob(os.path.join(HERE, "public_*.py")))
    if argv:
        files = [f for f in files if os.path.basename(f)[7:-3] in argv]
    total = failed = 0
    for path in files:
        label = os.path.basename(path)[7:-3]
        try:
            spec = importlib.util.spec_from_file_location("public_" + label, path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            examples = list(getattr(mod, "EXAMPLES"))
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {label}: could not load {os.path.basename(path)}: {type(e).__name__}: {e}")
            total += 1
            failed += 1
            continue
        for i, ex in enumerate(examples):
            total += 1
            try:
                ok, detail = _check_one(mod, ex)
            except Exception as e:  # noqa: BLE001
                ok, detail = False, f"{type(e).__name__}: {e}"
                if os.environ.get("PUBLIC_TRACEBACK"):
                    traceback.print_exc()
            failed += not ok
            line = f"{'PASS' if ok else 'FAIL'} {label}: {_name(ex, i)}"
            if not ok and detail:
                line += f"  -- {detail[:300]}"
            print(line)
    print(f"{total - failed}/{total} public examples passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
