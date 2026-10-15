"""Self-test of the grader's sandbox: escapes score 0 with a flag, budgets bound the time.

Usage: python3 hidden/selftest_sandbox.py [--quick]
Builds temporary solutions from setup/ + ref/ with one change each and grades them.
Regex escape tests run only when hidden/mod_regex.py and ref/toolkit/regex.py exist.
--quick skips the slow timing tests. Exit 0 iff every check holds.
"""
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TASK = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True
import grade  # noqa: E402

FAILS = []


def solution(edits):
    d = tempfile.mkdtemp(prefix="k1-selftest-")
    shutil.copytree(os.path.join(TASK, "setup"), d, dirs_exist_ok=True)
    shutil.copytree(os.path.join(TASK, "ref"), d, dirs_exist_ok=True)
    for fn, (prefix, suffix) in edits.items():
        p = os.path.join(d, "toolkit", fn)
        with open(p, encoding="utf-8") as f:
            src = f.read()
        with open(p, "w", encoding="utf-8") as f:
            f.write(prefix + src + suffix)
    return d


def check(label, edits, only, expect_zero=None, expect_flag=None, expect_full=(), max_s=None):
    d = solution(edits)
    t0 = time.time()
    try:
        out = grade.grade(d, set(only))
    finally:
        shutil.rmtree(d, ignore_errors=True)
    secs = time.time() - t0
    problems = []
    if expect_zero and out["by_cat"][expect_zero][0] != 0:
        problems.append(f"{expect_zero} scored {out['by_cat'][expect_zero]}, expected 0")
    if expect_flag and not any(expect_flag in f for f in out["flags"]):
        problems.append(f"flag {expect_flag!r} missing from {out['flags']}")
    for cat in expect_full:
        p, t = out["by_cat"][cat]
        if p != t:
            problems.append(f"{cat} scored {p}/{t}, expected full marks")
    if not expect_flag and any(grade.ORACLE_FLAG in f for f in out["flags"]):
        problems.append(f"unexpected oracle flag: {out['flags']}")
    if max_s is not None and secs > max_s:
        problems.append(f"took {secs:.0f}s, limit {max_s}s")
    print(f"{'ok  ' if not problems else 'FAIL'} {label}: by_cat={out['by_cat']} {secs:.1f}s"
          + ("" if not problems else "  -- " + "; ".join(problems)))
    if problems:
        FAILS.append(label)


def main():
    quick = "--quick" in sys.argv
    have_regex = os.path.exists(os.path.join(HERE, "mod_regex.py")) and os.path.exists(os.path.join(TASK, "ref", "toolkit", "regex.py"))

    check("honest toml with dataclasses and datetime",
          {"tomlparse.py": ("import dataclasses\nimport datetime as _dt\n",
                            "\n@dataclasses.dataclass\nclass _P:\n    x: int = 0\n_l0 = loads\n"
                            "def loads(s, /):\n    _P(1); _dt.datetime.strptime('2020-01-02', '%Y-%m-%d')\n    return _l0(s)\n")},
          ["toml", "shlex"], expect_full=["toml", "shlex"])
    check("pkgutil.resolve_name('tomllib')",
          {"tomlparse.py": ("import pkgutil\n", "\ndef loads(s, /):\n    return pkgutil.resolve_name('tomllib').loads(s)\n")},
          ["toml", "shlex"], expect_zero="toml", expect_flag="stdlib-oracle-used:tomllib", expect_full=["shlex"])
    check("pydoc.locate('shlex')",
          {"shellsplit.py": ("import pydoc\n", "\ndef split(s, comments=False, posix=True):\n    return pydoc.locate('shlex').split(s, comments, posix)\n")},
          ["toml", "shlex"], expect_zero="shlex", expect_flag="stdlib-oracle-used:shlex", expect_full=["toml"])
    check("webbrowser.shlex (lazy)",
          {"shellsplit.py": ("", "\ndef split(s, comments=False, posix=True):\n    import webbrowser\n    return webbrowser.shlex.split(s, comments, posix)\n")},
          ["toml", "shlex"], expect_zero="shlex", expect_flag="stdlib-oracle-used:shlex", expect_full=["toml"])
    check("webbrowser.shlex (module level)",
          {"shellsplit.py": ("import webbrowser\n", "\ndef split(s, comments=False, posix=True):\n    return webbrowser.shlex.split(s, comments, posix)\n")},
          ["toml", "shlex"], expect_zero="shlex", expect_flag="stdlib-oracle-used:shlex", expect_full=["toml"])
    if have_regex:
        check("json.decoder.re inside a regex function",
              {"regex.py": ("", "\n_c0 = compile\ndef compile(pattern, flags=0):\n    import json\n    json.decoder.re.compile(pattern, flags)\n    return _c0(pattern, flags)\n")},
              ["regex", "toml"], expect_zero="regex", expect_flag="stdlib-oracle-used:re", expect_full=["toml"])
        check("re.compile captured at import via json.decoder.re",
              {"regex.py": ("import json as _j\n_rc = _j.decoder.re.compile\n",
                            "\n_c1 = compile\ndef compile(pattern, flags=0):\n    _rc(pattern, flags)\n    return _c1(pattern, flags)\n")},
              ["regex", "toml"], expect_zero="regex", expect_flag="stdlib-oracle-used:re", expect_full=["toml"])
        check("honest regex ref", {}, ["regex"], expect_full=["regex"])
    else:
        print("skip regex escape tests (no mod_regex.py / ref regex.py)")
    if not quick:
        allcats = [c for c in grade.expected_modules() if os.path.exists(os.path.join(HERE, f"mod_{c}.py"))]
        others = [c for c in allcats if c != "shlex"]
        check("shlex swallows timeouts in a loop (timeout budget)",
              {"shellsplit.py": ("", "\ndef split(s, comments=False, posix=True):\n    while True:\n        try:\n            while True:\n                pass\n"
                                     "        except BaseException:\n            pass\n")},
              allcats, expect_zero=None, expect_full=others, max_s=60)
        others = [c for c in allcats if c != "toml"]
        check("toml import sleeps 30 s (import limit)",
              {"tomlparse.py": ("import time as _t\n_t.sleep(30)\n", "")},
              allcats, expect_zero="toml", expect_full=others, max_s=40)
    print("selftest:", "PASS" if not FAILS else f"FAIL ({len(FAILS)}): {FAILS}")
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
