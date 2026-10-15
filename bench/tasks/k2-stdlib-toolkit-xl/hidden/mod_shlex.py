"""Hidden differential cases for toolkit.shellsplit against shlex (Python 3.13).

Usage: python3 mod_shlex.py <package_root>   (imports <package_root>/toolkit directly)
"""
import random
import sys

NAME = "shlex"
MODULE = "toolkit.shellsplit"
ORACLES = ["shlex"]
WRAP = ["shlex.split", "shlex.quote", "shlex.join", "shlex.shlex"]

# (s, comments, posix)
SPLIT_HAND = [
    ('cp "my file.txt" /tmp/dest', False, True),
    ("echo 'it'\"'\"'s' done", False, True),
    ('a\\ b c\\\\d "e\\"f" \'g\\h\'', False, True),
    ('"in \\$dq \\` \\\\ \\x"', False, True),
    ("x=1 '' \"\" y''z", False, True),
    ("ls -la # list all\nrm -rf x# not a comment", True, True),
    ("ab#cd ef\ngh # tail", True, False),
    ('say "hello world" it\'s', False, False),
    ('a"b c"d \'e f\'g', False, False),
    ("  \t lead\r\ntrail  \n", False, True),
    ("unterminated 'quote", False, True),
    ('dangling escape\\', False, True),
    ('"no close', False, False),
    ("#all comment\n", True, True),
    ("a\\\nb \"c\\\nd\"", False, True),
    ("''#x '#' \"#\"y#z", True, True),
]

QUOTE_HAND = [
    "", "simple", "with space", "it's", "a@b%c+d=e:f,g./h-i_j", "$HOME", "semi;colon",
    "tab\there", "new\nline", "'", "''", "\"", "back\\slash", "*.py", "~user", "a!b", "x^y",
]

JOIN_HAND = [
    ["ls", "-l", "my dir"],
    [],
    ["", "a b", "it's", "plain"],
    ["echo", "$(rm -rf /)", "`id`", "a|b", "c&&d"],
    ["x'y'z", "\"q\"", "\\"],
]

ALPHABET = ["a", "b", "x", "1", "-", ".", "/", "=", " ", " ", " ", "\t", "\n", "'", "'", '"', '"',
            "\\", "\\", "#", "$", "*", "@", ";", "|", "~", "%", ","]


def _fuzz_split(r):
    if r.random() < 0.5:
        return "".join(r.choice(ALPHABET) for _ in range(r.randrange(1, 25)))
    parts = []
    for _ in range(r.randrange(1, 6)):
        k = r.randrange(6)
        word = "".join(r.choice("abxyz019-./=#$") for _ in range(r.randrange(0, 5)))
        if k == 0:
            parts.append(word)
        elif k == 1:
            parts.append("'" + word.replace("'", "") + r.choice(["", " ", "\\", '"', "#"]) + "'")
        elif k == 2:
            inner = "".join(r.choice(["a", " ", "\\\"", "\\\\", "\\$", "\\n", "'", "#", "\\"]) for _ in range(r.randrange(0, 5)))
            if inner.endswith("\\") and not inner.endswith("\\\\"):
                inner += "\\"
            parts.append('"' + inner + '"')
        elif k == 3:
            parts.append(word + "\\" + r.choice([" ", "'", '"', "#", "a", "\\", "\n"]) + word)
        elif k == 4:
            parts.append(word + r.choice(["'", '"']) * 2 + word)
        else:
            parts.append("#" + word)
    seps = [" ", "  ", "\t", "\n", "", " \n "]
    s = parts[0]
    for p in parts[1:]:
        s += r.choice(seps) + p
    return s


def _fuzz_quote(r):
    pool = "abcXYZ019_@%+=:,./- '\"\\$!*?;&|<>(){}[]~^#\t"
    return "".join(r.choice(pool) for _ in range(r.randrange(0, 10)))


def cases():
    out = []
    for i, (s, com, posix) in enumerate(SPLIT_HAND):
        out.append({"id": f"shlex-split-hand-{i:02d}", "fn": "split", "s": s, "comments": com, "posix": posix})
    r = random.Random(4242)
    modes = [(False, True), (True, True), (False, False), (True, False)]
    for i in range(32):
        com, posix = modes[i % 4]
        out.append({"id": f"shlex-split-fuzz-{i:02d}", "fn": "split", "s": _fuzz_split(r), "comments": com, "posix": posix})
    for i, s in enumerate(QUOTE_HAND[:9]):
        out.append({"id": f"shlex-quote-hand-{i:02d}", "fn": "quote", "s": s})
    for i in range(4):
        out.append({"id": f"shlex-quote-fuzz-{i:02d}", "fn": "quote", "s": _fuzz_quote(r)})
    for i, args in enumerate(JOIN_HAND):
        out.append({"id": f"shlex-join-hand-{i:02d}", "fn": "join", "args": args})
    for i in range(2):
        out.append({"id": f"shlex-join-fuzz-{i:02d}", "fn": "join", "args": [_fuzz_quote(r) for _ in range(r.randrange(1, 4))]})
    return out


def _call(split, quote, join, case):
    try:
        if case["fn"] == "split":
            kw = {}
            if case["comments"]:
                kw["comments"] = True
            if not case["posix"]:
                kw["posix"] = False
            res = split(case["s"], **kw)
            if not isinstance(res, list) or not all(isinstance(t, str) for t in res):
                return {"error": "split did not return a list of str"}
            return {"ok": list(res)}
        if case["fn"] == "quote":
            res = quote(case["s"])
        else:
            res = join(list(case["args"]))
        if not isinstance(res, str):
            return {"error": "result is not a str"}
        return {"ok": res}
    except ValueError:
        return {"error": "ValueError"}


def run_impl(mod, case):
    return _call(mod.split, mod.quote, mod.join, case)


def run_oracle(case):
    import shlex
    return _call(shlex.split, shlex.quote, shlex.join, case)


def same(a, b):
    return a == b


def _main(root):
    import importlib
    sys.path.insert(0, root)
    mod = importlib.import_module(MODULE)
    cs = cases()
    bad = []
    for c in cs:
        exp = run_oracle(c)
        try:
            got = run_impl(mod, c)
        except Exception as e:  # noqa: BLE001
            got = {"crash": f"{type(e).__name__}: {e}"}
        if not same(exp, got):
            bad.append((c, exp, got))
    print(f"{NAME}: {len(cs) - len(bad)}/{len(cs)}")
    for c, exp, got in bad[:10]:
        inp = {k: v for k, v in c.items() if k != "id"}
        print(f"  FAIL {c['id']} {str(inp)[:120]}\n    expected {str(exp)[:200]}\n    got      {str(got)[:200]}")
    return 0 if not bad else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: mod_shlex.py <package_root>")
    sys.exit(_main(sys.argv[1]))
