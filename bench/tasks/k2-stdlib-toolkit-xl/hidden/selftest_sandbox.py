"""Self-test of the grader's sandbox: escapes score 0 with a flag, budgets bound the time.

Usage: python3 hidden/selftest_sandbox.py [--quick]
Builds temporary solutions from setup/ + ref/ with one change each and grades them.
Regex escape tests run only when hidden/mod_regex.py and ref/toolkit/regex.py exist.
The data-driven checks grade against a temporary hidden dir holding a fake adapter
(toolkit.colors, which reimplements colorsys) declared only through ORACLES/WRAP.
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
    d = tempfile.mkdtemp(prefix="k2-selftest-")
    shutil.copytree(os.path.join(TASK, "setup"), d, dirs_exist_ok=True)
    shutil.copytree(os.path.join(TASK, "ref"), d, dirs_exist_ok=True)
    for fn, (prefix, suffix) in edits.items():
        p = os.path.join(d, "toolkit", fn)
        src = ""
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                src = f.read()
        with open(p, "w", encoding="utf-8") as f:
            f.write(prefix + src + suffix)
    return d


def check(label, edits, only, expect_zero=None, expect_flag=None, expect_full=(), max_s=None, hidden_dir=HERE):
    """expect_flag: a substring some flag must contain, or a tuple of alternatives (any one will do)."""
    d = solution(edits)
    t0 = time.time()
    try:
        out = grade.grade(d, set(only), hidden_dir=hidden_dir)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    secs = time.time() - t0
    problems = []
    for z in ([expect_zero] if isinstance(expect_zero, str) else expect_zero or []):
        if out["by_cat"][z][0] != 0:
            problems.append(f"{z} scored {out['by_cat'][z]}, expected 0")
    alts = (expect_flag,) if isinstance(expect_flag, str) else tuple(expect_flag or ())
    if alts and not any(a in f for a in alts for f in out["flags"]):
        problems.append(f"flag {' or '.join(map(repr, alts))} missing from {out['flags']}")
    for cat in expect_full:
        p, t = out["by_cat"][cat]
        if p != t or t == 0:
            problems.append(f"{cat} scored {p}/{t}, expected full marks")
    if not expect_flag and any(z in f for z in grade.ZERO_FLAGS for f in out["flags"]):
        problems.append(f"unexpected oracle flag: {out['flags']}")
    if max_s is not None and secs > max_s:
        problems.append(f"took {secs:.0f}s, limit {max_s}s")
    print(f"{'ok  ' if not problems else 'FAIL'} {label}: by_cat={out['by_cat']} {secs:.1f}s"
          + ("" if not problems else "  -- " + "; ".join(problems)))
    if problems:
        FAILS.append(label)


FAKE_COLORS = '''"""Fake adapter for the selftest: toolkit.colors reimplements colorsys.rgb_to_yiq."""
import json  # bookkeeping import at top level; json is the fake jx module's oracle

NAME = "colors"
MODULE = "toolkit.colors"
ORACLES = ["colorsys"]
WRAP = ["colorsys.rgb_to_yiq"]


def cases():
    pts = [(0.0, 0.0, 0.0), (1.0, 1.0, 1.0), (0.2, 0.4, 0.6), (0.9, 0.1, 0.5), (0.33, 0.66, 0.99)]
    return [{"id": "colors-%d" % i, "rgb": list(p)} for i, p in enumerate(pts)]


def run_impl(mod, case):
    return json.loads(json.dumps(list(mod.rgb_to_yiq(*case["rgb"]))))


def run_oracle(case):
    import colorsys
    return list(colorsys.rgb_to_yiq(*case["rgb"]))
'''
FAKE_JX = '''"""Fake adapter for the selftest: toolkit.jx reimplements json.dumps for ints."""
NAME = "jx"
MODULE = "toolkit.jx"
ORACLES = ["json", "_json"]
WRAP = ["json.dumps", "json.loads"]


def cases():
    return [{"id": "jx-%d" % n, "n": n} for n in (0, 7, -3, 10 ** 20)]


def run_impl(mod, case):
    return mod.dumps(case["n"])


def run_oracle(case):
    import json
    return json.dumps(case["n"])
'''
TW_TEXTS = ["  a\n  b\n", "\tx\n\ty\n", "    one\n      two\n", "no indent\n"]
FAKE_TW = '''"""Fake adapter for the selftest: toolkit.tw reimplements textwrap.dedent."""
NAME = "tw"
MODULE = "toolkit.tw"
ORACLES = ["textwrap"]
WRAP = ["textwrap.dedent", "textwrap.TextWrapper"]
TEXTS = %s


def cases():
    return [{"id": "tw-%%d" %% i, "s": s} for i, s in enumerate(TEXTS)]


def run_impl(mod, case):
    return mod.dedent(case["s"])


def run_oracle(case):
    import textwrap
    return textwrap.dedent(case["s"])
''' % TW_TEXTS
HONEST_COLORS = '''def rgb_to_yiq(r, g, b):
    y = 0.30*r + 0.59*g + 0.11*b
    i = 0.74*(r-y) - 0.27*(b-y)
    q = 0.48*(r-y) + 0.41*(b-y)
    return (y, i, q)
'''
HONEST_JX = "def dumps(n):\n    return str(int(n))\n"
# Laundering: a module reads answers that another module's code computed in its own child.
LAUNDER_READ = ('''
import marshal as _lm, os as _lo
_ANS = _lo.path.join(_lo.path.dirname(_lo.path.abspath(__spec__.origin)), "_laundered.marshal")


def _answers():
    for _ in range(5):
        if _lo.path.exists(_ANS):
            with open(_ANS, "rb") as f:
                return _lm.load(f)
        import time
        time.sleep(0.02)
    return {}
''')


def fake_hidden(adapters, counts):
    """A hidden dir with the shlex adapter plus the given fake adapters, nothing else."""
    d = tempfile.mkdtemp(prefix="k2-selftest-hidden-")
    shutil.copy(os.path.join(HERE, "mod_shlex.py"), d)
    for name, src in adapters.items():
        with open(os.path.join(d, f"mod_{name}.py"), "w", encoding="utf-8") as f:
            f.write(src)
    with open(os.path.join(d, "modules.json"), "w", encoding="utf-8") as f:
        f.write(counts + "\n")
    return d


def data_driven_checks():
    hd = fake_hidden({"colors": FAKE_COLORS, "jx": FAKE_JX}, '{"shlex": 68, "colors": null, "jx": null}')
    both = ["shlex", "colors"]
    honest = {"colors.py": ("", HONEST_COLORS), "jx.py": ("", HONEST_JX)}
    try:
        check("honest colors and jx (fake adapters; the colors adapter imports json, jx's oracle, at top level)",
              honest, ["shlex", "colors", "jx"], expect_full=["shlex", "colors", "jx"], hidden_dir=hd)
        check("colors: import colorsys",
              {**honest, "colors.py": ("import colorsys\n", HONEST_COLORS)}, both,
              expect_zero="colors", expect_flag="stdlib-oracle-refused:colorsys", expect_full=["shlex"], hidden_dir=hd)
        check("colors: pkgutil.resolve_name('colorsys') at call time",
              {**honest, "colors.py": ("import pkgutil\n", "\ndef rgb_to_yiq(r, g, b):\n"
                                       "    return pkgutil.resolve_name('colorsys').rgb_to_yiq(r, g, b)\n")},
              both, expect_zero="colors", expect_flag="stdlib-oracle-refused:colorsys", expect_full=["shlex"], hidden_dir=hd)
        check("colors: runpy.run_path(<stdlib>/colorsys.py)",
              {**honest, "colors.py": ("import os as _o, runpy as _r\n",
                                       "\ndef rgb_to_yiq(r, g, b):\n"
                                       "    ns = _r.run_path(_o.path.join(_o.path.dirname(_o.__file__), 'colorsys.py'))\n"
                                       "    return ns['rgb_to_yiq'](r, g, b)\n")},
              both, expect_zero="colors", expect_flag="stdlib-oracle-used:colorsys", expect_full=["shlex"], hidden_dir=hd)
        check("shellsplit imports colorsys (another category's oracle: refused, zeroes the importer only)",
              {**honest, "shellsplit.py": ("import colorsys\n", "")}, both,
              expect_zero="shlex", expect_flag="stdlib-oracle-refused:colorsys", expect_full=["colors"], hidden_dir=hd)
    finally:
        shutil.rmtree(hd, ignore_errors=True)


HONEST_TW = """def dedent(s):
    lines = s.split("\\n")
    leads = [l[:len(l) - len(l.lstrip(" \\t"))] for l in lines if l.strip(" \\t")]
    p = leads[0] if leads else ""
    for x in leads[1:]:
        while not x.startswith(p):
            p = p[:-1]
    return "\\n".join(l[len(p):] if l.strip(" \\t") else "" for l in lines)
"""
FAKE_DFK = '''"""Fake adapter for the selftest: toolkit.dfk reimplements difflib.IS_CHARACTER_JUNK."""
NAME = "dfk"
MODULE = "toolkit.dfk"
ORACLES = ["difflib"]
WRAP = ["difflib.IS_CHARACTER_JUNK"]


def cases():
    return [{"id": "dfk-%d" % i, "ch": ch} for i, ch in enumerate(" \\tax#\\n")]


def run_impl(mod, case):
    return bool(mod.IS_CHARACTER_JUNK(case["ch"]))


def run_oracle(case):
    import difflib
    return bool(difflib.IS_CHARACTER_JUNK(case["ch"]))
'''
HONEST_DFK = "def IS_CHARACTER_JUNK(ch, ws=\" \\t\"):\n    return ch in ws\n"


def refusal_fairness_checks():
    # pydoc imports textwrap: importing pydoc is refused and zeroes the importer, not tw.
    hd = fake_hidden({"tw": FAKE_TW, "dfk": FAKE_DFK}, '{"shlex": 68, "tw": null, "dfk": null}')
    honest = {"tw.py": ("", HONEST_TW), "dfk.py": ("", HONEST_DFK)}
    try:
        check("honest tw and dfk (fake adapters)", honest, ["tw", "dfk"], expect_full=["tw", "dfk"], hidden_dir=hd)
        check("pydoc.locate inside dfk.py (pydoc imports textwrap): zeroes dfk only, not tw",
              {**honest, "dfk.py": ("import pydoc\n", HONEST_DFK + "\n_d = pydoc.locate('difflib')\n")},
              ["tw", "dfk"], expect_zero="dfk", expect_flag="stdlib-oracle-refused:textwrap", expect_full=["tw"],
              hidden_dir=hd)
    finally:
        shutil.rmtree(hd, ignore_errors=True)
    # Solution code runs the adapter's run_oracle in a new thread. With the thread's target being
    # run_oracle itself, no toolkit frame is on that stack: the import is refused silently.
    finder = (
        "\nimport sys as _ts, threading as _tt\n_s2 = split\n_seen = {}\n"
        "def _adapter_run_oracle():\n"
        "    f = _ts._getframe(1)\n"
        "    while f is not None:\n"
        "        a = f.f_globals.get('adapter')\n"
        "        if hasattr(a, 'run_oracle'):\n            return a.run_oracle\n"
        "        f = f.f_back\n"
        "_CASE = {'fn': 'split', 's': 'a b', 'comments': False, 'posix': True}\n")
    direct = finder + (
        "def split(s, comments=False, posix=True):\n"
        "    if not _seen:\n"
        "        ro = _adapter_run_oracle()\n"
        "        if ro is None:\n            return ['probe found no adapter']\n"
        "        t = _tt.Thread(target=ro, args=(_CASE,))\n        t.start()\n        t.join()\n"
        "        _seen['done'] = True\n"
        "    if 'shlex' in _ts.modules:\n        return ['oracle loaded from a thread']\n"
        "    return _s2(s, comments, posix)\n")
    check("adapter run_oracle as a solution thread's target: the oracle import is refused",
          {"shellsplit.py": ("", direct)}, ["shlex"], expect_full=["shlex"])
    # Through a toolkit function in the thread, the attempt is also flagged as refused.
    wrapped = finder + (
        "def _steal(ro):\n"
        "    try:\n        _seen['r'] = ro(_CASE)\n"
        "    except BaseException as e:\n        _seen['e'] = type(e).__name__\n"
        "def split(s, comments=False, posix=True):\n"
        "    if not _seen:\n"
        "        t = _tt.Thread(target=_steal, args=(_adapter_run_oracle(),))\n        t.start()\n        t.join()\n"
        "    if 'r' in _seen:\n        return ['oracle reached from a thread']\n"
        "    return _s2(s, comments, posix)\n")
    check("adapter run_oracle via a toolkit function in a thread: refused and flagged",
          {"shellsplit.py": ("", wrapped)}, ["shlex"], expect_zero="shlex", expect_flag="stdlib-oracle-refused:shlex")


def laundering_checks():
    # The import that would reach the oracle is refused: the module that tried it scores 0 (flagged
    # as refused), and the laundered module gets no answers, so it scores 0 as well.
    # csvx, in the csv child, gets shlex through webbrowser and hands shellsplit its answers.
    launder_shlex = (
        "import glob as _lg, marshal as _lm2, os as _lo2, tempfile as _lt\n"
        "try:\n"
        "    import webbrowser as _wb\n"
        "    _jobs = _lg.glob(_lo2.path.join(_lt.gettempdir(), 'k2-job-*'))\n"
        "    _out = {}\n"
        "    for _j in _jobs:\n"
        "        try:\n"
        "            with open(_j, 'rb') as _f:\n"
        "                _job = _lm2.load(_f)\n"
        "            for _c in (_job.get('cases') if isinstance(_job, dict) else _job):\n"
        "                if _c.get('fn') == 'split':\n"
        "                    try:\n"
        "                        _out[_c['s'], bool(_c['comments']), bool(_c['posix'])] = _wb.shlex.split(_c['s'], _c['comments'], _c['posix'])\n"
        "                    except ValueError:\n"
        "                        _out[_c['s'], bool(_c['comments']), bool(_c['posix'])] = 'ValueError'\n"
        "        except Exception:\n"
        "            pass\n"
        "    _out['probe'] = _wb.shlex.split('a b')\n"
        "    with open(_lo2.path.join(_lo2.path.dirname(_lo2.path.abspath(__spec__.origin)), '_laundered.marshal'), 'wb') as _f:\n"
        "        _lm2.dump(_out, _f)\n"
        "except Exception:\n"
        "    pass\n")
    read_shlex = LAUNDER_READ + (
        "\n\ndef split(s, comments=False, posix=True):\n"
        "    r = _answers().get((s, bool(comments), bool(posix)))\n"
        "    if r == 'ValueError':\n        raise ValueError('laundered')\n"
        "    return r if r is not None else ['no laundered answer']\n"
        "\n\ndef quote(s):\n    return 'no laundered answer'\n"
        "\n\ndef join(split_command):\n    return 'no laundered answer'\n")
    check("laundering: csvx computes shellsplit's answers with webbrowser.shlex",
          {"csvx.py": (launder_shlex, ""), "shellsplit.py": ("", read_shlex)}, ["csv", "shlex"],
          expect_zero=["shlex", "csv"], expect_flag="stdlib-oracle-refused:shlex")
    # shellsplit, in the shlex child, gets textwrap through logging (-> traceback) for the fake tw module.
    hd = fake_hidden({"tw": FAKE_TW}, '{"shlex": 68, "tw": null}')
    launder_tw = (
        "try:\n"
        "    import logging as _lg, marshal as _lm3, os as _lo3\n"
        "    _tw = _lg.traceback.textwrap\n"
        "    _out = {s: _tw.dedent(s) for s in %r}\n"
        "    with open(_lo3.path.join(_lo3.path.dirname(_lo3.path.abspath(__spec__.origin)), '_laundered.marshal'), 'wb') as _f:\n"
        "        _lm3.dump(_out, _f)\n"
        "except Exception:\n"
        "    pass\n" % (TW_TEXTS,))
    read_tw = LAUNDER_READ + (
        "\n\ndef dedent(s):\n"
        "    r = _answers().get(s)\n"
        "    return r if r is not None else 'no laundered answer'\n")
    try:
        check("laundering: shellsplit computes tw's answers with logging.traceback.textwrap",
              {"shellsplit.py": (launder_tw, ""), "tw.py": ("", read_tw)}, ["shlex", "tw"],
              expect_zero=["tw", "shlex"], expect_flag="stdlib-oracle-refused:textwrap", hidden_dir=hd)
    finally:
        shutil.rmtree(hd, ignore_errors=True)


def refused_os_checks():
    # The solution returns the right answer only when the call is refused with PermissionError.
    check("os.system from solution code is refused",
          {"shellsplit.py": ("import os as _os\n",
                             "\n_s0 = split\ndef split(s, comments=False, posix=True):\n"
                             "    try:\n        _os.system('true')\n    except PermissionError:\n"
                             "        return _s0(s, comments, posix)\n    return ['os.system was allowed']\n")},
          ["shlex"], expect_full=["shlex"])
    check("os.link from solution code is refused",
          {"shellsplit.py": ("import os as _os, shutil as _sh, tempfile as _t\n",
                             "\n_s1 = split\ndef split(s, comments=False, posix=True):\n"
                             "    d = _t.mkdtemp()\n    src = _os.path.join(d, 'a')\n"
                             "    open(src, 'w').close()\n"
                             "    try:\n        _os.link(src, _os.path.join(d, 'b'))\n    except PermissionError:\n"
                             "        return _s1(s, comments, posix)\n    finally:\n        _sh.rmtree(d)\n"
                             "    return ['os.link was allowed']\n")},
          ["shlex"], expect_full=["shlex"])


RE_OR_JSON = ("stdlib-oracle-used:re", "stdlib-oracle-refused:json")


def calendar_checks():
    # calendar is watch-only (mod_cal declares WATCH_ONLY = True): _strptime imports it.
    check("honest shellsplit using datetime.strptime (loads calendar via _strptime)",
          {"shellsplit.py": ("import datetime as _dt\n",
                             "\n_s3 = split\ndef split(s, comments=False, posix=True):\n"
                             "    _dt.datetime.strptime('2021-03-04', '%Y-%m-%d')\n    return _s3(s, comments, posix)\n")},
          ["shlex", "cal"], expect_full=["shlex", "cal"])
    check("cal calls calendar.monthrange (via _strptime.calendar) during cal cases",
          {"cal.py": ("import _strptime as _sp\n",
                      "\n_mr0 = monthrange\ndef monthrange(year, month):\n"
                      "    _sp.calendar.monthrange(year, month)\n    return _mr0(year, month)\n")},
          ["cal", "shlex"], expect_zero="cal", expect_flag="stdlib-oracle-used:calendar", expect_full=["shlex"])
    # _strptime calls calendar.isleap for this %W date (week 0 falls in the previous year): genuine
    # _strptime code is a declared WATCH_CALLER of calendar, so honest cal code may do this.
    check("honest cal calling datetime.strptime with %W during cal cases (_strptime calls calendar.isleap)",
          {"cal.py": ("import datetime as _dt\n",
                      "\n_mr1 = monthrange\ndef monthrange(year, month):\n"
                      "    _dt.datetime.strptime('2017 0 1', '%Y %W %w')\n    return _mr1(year, month)\n")},
          ["cal", "shlex"], expect_full=["cal", "shlex"])
    # Any other stdlib proxy still counts: email._parseaddr.mktime_tz calls calendar.timegm.
    check("cal computes timegm through email._parseaddr.mktime_tz (a stdlib proxy, not a WATCH_CALLER)",
          {"cal.py": ("import email._parseaddr as _pa\n",
                      "\n_mr2 = monthrange\ndef monthrange(year, month):\n"
                      "    _pa.mktime_tz((year, month, 1, 0, 0, 0, 0, 1, 0, 0))\n    return _mr2(year, month)\n")},
          ["cal", "shlex"], expect_zero="cal", expect_flag="stdlib-oracle-used:calendar", expect_full=["shlex"])
    # Code compiled under _strptime's filename is not genuine _strptime code: the call still counts.
    check("cal calls calendar from code compiled with _strptime.py as its filename",
          {"cal.py": ("import os as _o\n_ns = {}\n"
                      "_code = compile('import calendar as _c\\ndef mr(y, m):\\n    return _c.monthrange(y, m)\\n',"
                      " _o.path.join(_o.path.dirname(_o.__file__), '_strptime.py'), 'exec')\n"
                      "_bi = __builtins__ if isinstance(__builtins__, dict) else vars(__builtins__)\n"
                      "_bi['ex' + 'ec'](_code, _ns)\n",
                      "\n_mr3 = monthrange\ndef monthrange(year, month):\n"
                      "    _ns['mr'](year, month)\n    return _mr3(year, month)\n")},
          ["cal", "shlex"], expect_zero="cal", expect_flag="stdlib-oracle-used:calendar", expect_full=["shlex"])


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
          ["toml", "shlex"], expect_zero="toml", expect_flag="stdlib-oracle-refused:tomllib", expect_full=["shlex"])
    check("pydoc.locate('shlex')",
          {"shellsplit.py": ("import pydoc\n", "\ndef split(s, comments=False, posix=True):\n    return pydoc.locate('shlex').split(s, comments, posix)\n")},
          ["toml", "shlex"], expect_zero="shlex", expect_flag="stdlib-oracle-refused:", expect_full=["toml"])
    check("webbrowser.shlex (lazy)",
          {"shellsplit.py": ("", "\ndef split(s, comments=False, posix=True):\n    import webbrowser\n    return webbrowser.shlex.split(s, comments, posix)\n")},
          ["toml", "shlex"], expect_zero="shlex", expect_flag="stdlib-oracle-refused:shlex", expect_full=["toml"])
    check("webbrowser.shlex (module level)",
          {"shellsplit.py": ("import webbrowser\n", "\ndef split(s, comments=False, posix=True):\n    return webbrowser.shlex.split(s, comments, posix)\n")},
          ["toml", "shlex"], expect_zero="shlex", expect_flag="stdlib-oracle-refused:shlex", expect_full=["toml"])
    check("runpy.run_path(<stdlib>/shlex.py)",
          {"shellsplit.py": ("import os as _o, runpy as _r\n",
                             "\ndef split(s, comments=False, posix=True):\n"
                             "    ns = _r.run_path(_o.path.join(_o.path.dirname(_o.__file__), 'shlex.py'))\n"
                             "    return ns['split'](s, comments, posix)\n")},
          ["toml", "shlex"], expect_zero="shlex", expect_flag="stdlib-oracle-used:shlex", expect_full=["toml"])
    check("shutil.copytree(<stdlib>/tomllib) imported as mytoml",
          {"tomlparse.py": ("import os as _o, sys as _s, shutil as _sh, tempfile as _t, pkgutil as _p\n",
                            "\ndef loads(s, /):\n    tmp = _t.mkdtemp()\n"
                            "    _sh.copytree(_o.path.join(_o.path.dirname(_o.__file__), 'tomllib'), _o.path.join(tmp, 'mytoml'))\n"
                            "    _s.path.insert(0, tmp)\n    return _p.resolve_name('mytoml').loads(s)\n")},
          ["toml", "shlex"], expect_zero="toml", expect_flag="stdlib-oracle-used:tomllib", expect_full=["shlex"])
    check("symlink to <stdlib>/tomllib imported as mytoml2",
          {"tomlparse.py": ("import os as _o, sys as _s, tempfile as _t, pkgutil as _p\n",
                            "\ndef loads(s, /):\n    tmp = _t.mkdtemp()\n"
                            "    _o.symlink(_o.path.join(_o.path.dirname(_o.__file__), 'tomllib'), _o.path.join(tmp, 'mytoml2'))\n"
                            "    _s.path.insert(0, tmp)\n    return _p.resolve_name('mytoml2').loads(s)\n")},
          ["toml", "shlex"], expect_zero="toml", expect_flag="stdlib-oracle-used:tomllib", expect_full=["shlex"])
    if have_regex:
        check("json.decoder.re inside a regex function",
              {"regex.py": ("", "\n_c0 = compile\ndef compile(pattern, flags=0):\n    import json\n    json.decoder.re.compile(pattern, flags)\n    return _c0(pattern, flags)\n")},
              ["regex", "toml"], expect_zero="regex", expect_flag=RE_OR_JSON, expect_full=["toml"])
        check("re.compile captured at import via json.decoder.re",
              {"regex.py": ("import json as _j\n_rc = _j.decoder.re.compile\n",
                            "\n_c1 = compile\ndef compile(pattern, flags=0):\n    _rc(pattern, flags)\n    return _c1(pattern, flags)\n")},
              ["regex", "toml"], expect_zero="regex", expect_flag=RE_OR_JSON, expect_full=["toml"])
        check("honest regex ref", {}, ["regex"], expect_full=["regex"])
    else:
        print("skip regex escape tests (no mod_regex.py / ref regex.py)")
    if os.path.exists(os.path.join(HERE, "mod_cal.py")):
        calendar_checks()
    data_driven_checks()
    refused_os_checks()
    laundering_checks()
    refusal_fairness_checks()
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
