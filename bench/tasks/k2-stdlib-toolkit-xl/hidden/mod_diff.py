"""Hidden differential cases for toolkit.diff (graded against `difflib`).

Adapter interface: NAME, MODULE, ORACLES, WRAP, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_diff.py <package_root>` runs the
self-test against <package_root>/toolkit/diff.py.

cases() imports neither `difflib` nor the solution; inputs are generated from
a fixed seed.
"""

import json
import random
import sys
import time

NAME = "diff"
MODULE = "toolkit.diff"
ORACLES = ["difflib"]
WRAP = [
    "difflib.SequenceMatcher",
    "difflib.unified_diff",
    "difflib.context_diff",
    "difflib.ndiff",
    "difflib.restore",
    "difflib.get_close_matches",
    "difflib.IS_LINE_JUNK",
    "difflib.IS_CHARACTER_JUNK",
]

# Junk predicates a case can name (spec/diff.md lists them).
_PREDS = {
    "space": lambda x: x == " ",
    "blank": lambda x: x.strip() == "",
    "vowel": lambda x: x in ("a", "e", "i", "o", "u"),
    "hash": lambda x: x.startswith("#"),
}


def _pred(mod, name):
    if name is None:
        return None
    if name in ("IS_LINE_JUNK", "IS_CHARACTER_JUNK"):
        return getattr(mod, name)
    return _PREDS[name]


# ----------------------------------------------------------- normalization

def _kind(e):
    return type(e).__name__


def _match(m):
    return [list(m), [m.a, m.b, m.size]]


def _call(mod, sm, call):
    meth, args = call[0], call[1:]
    if meth in ("set_seqs", "set_seq1", "set_seq2"):
        getattr(sm, meth)(*args)
        return None
    if meth == "find_longest_match":
        return _match(sm.find_longest_match(*args))
    if meth == "get_matching_blocks":
        return [_match(m) for m in sm.get_matching_blocks()]
    if meth == "get_opcodes":
        return [list(op) for op in sm.get_opcodes()]
    if meth == "get_grouped_opcodes":
        return [[list(op) for op in g] for g in sm.get_grouped_opcodes(*args)]
    if meth in ("ratio", "quick_ratio", "real_quick_ratio"):
        return getattr(sm, meth)()
    raise ValueError(meth)


def _run(mod, case):
    op = case["op"]
    try:
        if op == "sm":
            kw = {}
            if "autojunk" in case:
                kw["autojunk"] = case["autojunk"]
            sm = mod.SequenceMatcher(_pred(mod, case.get("isjunk")), case["a"], case["b"], **kw)
            out = []
            for call in case["calls"]:
                try:
                    out.append(_call(mod, sm, call))
                except Exception as e:  # noqa: BLE001
                    out.append({"error": _kind(e)})
            return out
        if op in ("unified", "context"):
            fn = mod.unified_diff if op == "unified" else mod.context_diff
            return list(fn(case["a"], case["b"], **case.get("kwargs", {})))
        if op == "ndiff":
            kw = {}
            if "linejunk" in case:
                kw["linejunk"] = _pred(mod, case["linejunk"])
            if "charjunk" in case:
                kw["charjunk"] = _pred(mod, case["charjunk"])
            return list(mod.ndiff(case["a"], case["b"], **kw))
        if op == "restore":
            return list(mod.restore(case["delta"], case["which"]))
        if op == "close":
            return mod.get_close_matches(case["word"], case["poss"], **case.get("kwargs", {}))
        if op == "linejunk":
            return [bool(mod.IS_LINE_JUNK(x)) for x in case["inputs"]]
        if op == "charjunk":
            return [bool(mod.IS_CHARACTER_JUNK(x)) for x in case["inputs"]]
    except Exception as e:  # noqa: BLE001
        return {"error": _kind(e)}
    raise ValueError(op)


def run_impl(mod, case):
    return _run(mod, case)


def run_oracle(case):
    import difflib
    return _run(difflib, case)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

_ALL = [["get_matching_blocks"], ["get_opcodes"], ["ratio"], ["quick_ratio"],
        ["real_quick_ratio"], ["find_longest_match"]]


def _lines(text):
    return text.splitlines(True)


def _hand():
    H = []

    def SM(a, b, calls=None, **kw):
        c = {"op": "sm", "a": a, "b": b, "calls": calls if calls is not None else _ALL + [["get_grouped_opcodes"]]}
        c.update(kw)
        H.append(c)

    # basics on strings
    SM("abxcd", "abcd")
    SM("", "")
    SM("", "abc")
    SM("abc", "")
    SM("abcd", "abcd")
    SM("qabxcd", "abycdf")
    SM("private Thread currentThread;", "private volatile Thread currentThread;",
       isjunk="space")
    SM(" abcd", "abcd abcd", calls=[["find_longest_match", 0, 5, 0, 9],
                                    ["find_longest_match"]])
    SM(" abcd", "abcd abcd", isjunk="space",
       calls=[["find_longest_match", 0, 5, 0, 9], ["get_matching_blocks"]])
    SM("ab", "c", calls=[["find_longest_match", 0, 2, 0, 1], ["get_opcodes"]])
    # tie-breaking: earliest in a, then earliest in b
    SM("xyzxyz", "xyzabcxyz", calls=[["find_longest_match"],
                                     ["find_longest_match", 1, 6, 0, 9],
                                     ["find_longest_match", 0, 6, 4, 9],
                                     ["get_matching_blocks"]])
    SM("aaaa", "aa", calls=_ALL)
    SM("abab", "baba", calls=_ALL)
    # junk extension at the edges of a match
    SM("a  b c", "a b  c", isjunk="space", calls=_ALL)
    SM("hello world", "hollow word", isjunk="vowel", calls=_ALL)
    # set_seq* reuse
    SM("abcdef", "abxdef", calls=[["ratio"], ["set_seq1", "abxdeg"], ["get_opcodes"],
                                  ["set_seq2", "zbxdeg"], ["get_matching_blocks"],
                                  ["quick_ratio"], ["set_seqs", "kitten", "sitting"],
                                  ["get_opcodes"], ["ratio"]])
    SM("a b", "b a", isjunk="space",
       calls=[["set_seq2", "  a  "], ["find_longest_match"], ["get_opcodes"]])
    # lists of lines
    a = _lines("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n")
    b = _lines("one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n")
    SM(a, b, calls=_ALL + [["get_grouped_opcodes", 1]])
    SM(a, b, calls=[["get_grouped_opcodes", 0]])
    SM(a, b, calls=[["get_grouped_opcodes", 5]])
    SM(a, list(a), calls=[["get_opcodes"], ["get_grouped_opcodes"]])
    SM(["#x\n", "\n", "a\n", "\n", "b\n"], ["a\n", "\n", "\n", "b\n", "#y\n"],
       isjunk="IS_LINE_JUNK", calls=_ALL)
    SM(["a\n", "  \n", "b\n"], ["a\n", "b\n", " \n"], isjunk="blank", calls=_ALL)
    SM(["x", "#c", "y"], ["#c", "x", "y"], isjunk="hash", calls=_ALL)
    # popular-element rule (200+ items in b)
    big_b = ["x%d\n" % i if i % 7 else "\n" for i in range(210)]
    big_a = [ln for i, ln in enumerate(big_b) if i % 13]
    SM(big_a, big_b, calls=[["get_matching_blocks"], ["ratio"], ["get_grouped_opcodes", 2]])
    SM(big_a, big_b, autojunk=False, calls=[["get_matching_blocks"], ["ratio"]])
    s200 = ("ab" * 120)[:240]
    SM("ab" * 3 + "c", s200, calls=[["get_matching_blocks"], ["ratio"], ["quick_ratio"]])
    SM("ab" * 3 + "c", s200, autojunk=False, calls=[["get_matching_blocks"], ["ratio"]])
    # exactly at the threshold: 200 items, element count 3 is not > 200//100+1
    t = ["k\n" if i in (5, 50, 150) else "v%d\n" % i for i in range(200)]
    SM(["k\n"], t, calls=[["get_matching_blocks"]])
    t2 = ["k\n" if i in (5, 50, 150, 199) else "v%d\n" % i for i in range(200)]
    SM(["k\n"], t2, calls=[["get_matching_blocks"]])
    SM(["k\n", "v6\n"], t2, calls=[["get_matching_blocks"]])
    SM(["k\n"], t2[:199], calls=[["get_matching_blocks"]])
    # a has 200+ items but b does not: no popular elimination
    SM(["z\n"] * 230, ["z\n", "y\n", "z\n"], calls=[["get_matching_blocks"], ["ratio"]])

    # unified / context
    a = _lines("one\ntwo\nthree\nfour\n")
    b = _lines("zero\none\ntree\nfour\n")
    H.append({"op": "unified", "a": a, "b": b,
              "kwargs": {"fromfile": "Original", "tofile": "Current",
                         "fromfiledate": "2005-01-26 23:30:50", "tofiledate": "2010-04-12 10:20:52"}})
    H.append({"op": "unified", "a": ["a", "b", "c"], "b": ["a", "B", "c"],
              "kwargs": {"lineterm": "", "n": 0}})
    H.append({"op": "unified", "a": a, "b": a})
    H.append({"op": "unified", "a": [], "b": ["x\n"]})
    H.append({"op": "unified", "a": ["x\n"], "b": []})
    H.append({"op": "unified", "a": [], "b": []})
    H.append({"op": "context", "a": a, "b": b,
              "kwargs": {"fromfile": "before.py", "tofile": "after.py"}})
    H.append({"op": "context", "a": ["a", "b", "c"], "b": ["a", "c"],
              "kwargs": {"lineterm": "", "n": 1, "fromfiledate": "d1"}})
    H.append({"op": "context", "a": ["a\n", "c\n"], "b": ["a\n", "b\n", "c\n"],
              "kwargs": {"n": 0, "tofiledate": "d2"}})
    H.append({"op": "context", "a": [], "b": []})
    long_a = ["l%d\n" % i for i in range(30)]
    long_b = list(long_a)
    long_b[3] = "L3\n"
    long_b[20:22] = []
    long_b.insert(27, "new\n")
    H.append({"op": "unified", "a": long_a, "b": long_b, "kwargs": {"n": 2}})
    H.append({"op": "context", "a": long_a, "b": long_b, "kwargs": {"n": 4}})

    # ndiff / restore
    H.append({"op": "ndiff", "a": _lines("one\ntwo\nthree\n"), "b": _lines("ore\ntree\nemu\n")})
    H.append({"op": "ndiff", "a": _lines("\tTab\nsame\n"), "b": _lines("\tTabs\nsame\n")})
    H.append({"op": "ndiff", "a": ["abcdefgh\n", "x\n"], "b": ["x\n", "abcdefgh\n"]})
    H.append({"op": "ndiff", "a": ["aaa\n", "bbb\n", "ccc\n"], "b": ["zzz\n", "yyy\n"]})
    H.append({"op": "ndiff", "a": ["apple pie\n", "same\n", "banana\n"],
              "b": ["same\n", "appel pie\n", "bananas\n"]})
    H.append({"op": "ndiff", "a": ["  \n", "a b c\n", "#\n"], "b": ["a  b c\n", "\n", "# x\n"],
              "linejunk": "IS_LINE_JUNK"})
    H.append({"op": "ndiff", "a": ["a b c d\n"], "b": ["a-b c-d\n"], "charjunk": None})
    H.append({"op": "ndiff", "a": [], "b": ["x\n"]})
    H.append({"op": "ndiff", "a": ["q\n", "same\n", "w\n"], "b": ["e\n", "same\n", "r\n"]})
    delta = ["  one\n", "- two\n", "?  ^\n", "+ tWo\n", "?  ^\n", "+ new\n", "- old\n", "  end\n"]
    H.append({"op": "restore", "delta": delta, "which": 1})
    H.append({"op": "restore", "delta": delta, "which": 2})
    H.append({"op": "restore", "delta": delta, "which": 3})
    H.append({"op": "restore", "delta": delta, "which": 0})
    H.append({"op": "restore", "delta": [], "which": 2})

    # get_close_matches
    H.append({"op": "close", "word": "appel", "poss": ["ape", "apple", "peach", "puppy"]})
    H.append({"op": "close", "word": "wheel",
              "poss": ["while", "for", "with", "return", "whale", "wheels", "heel"]})
    H.append({"op": "close", "word": "abc", "poss": ["abd", "abe", "abf", "xbc", "abc"],
              "kwargs": {"n": 2}})
    H.append({"op": "close", "word": "abc", "poss": ["abd", "abe", "abf", "xbc"],
              "kwargs": {"n": 10, "cutoff": 0.0}})
    H.append({"op": "close", "word": "abc", "poss": ["abc", "x"], "kwargs": {"cutoff": 1.0}})
    H.append({"op": "close", "word": "abc", "poss": ["abc"], "kwargs": {"n": 0}})
    H.append({"op": "close", "word": "abc", "poss": ["abc"], "kwargs": {"n": -2}})
    H.append({"op": "close", "word": "abc", "poss": ["abc"], "kwargs": {"cutoff": 1.5}})
    H.append({"op": "close", "word": "abc", "poss": ["abc"], "kwargs": {"cutoff": -0.1}})
    H.append({"op": "close", "word": "", "poss": ["", "a"], "kwargs": {"cutoff": 0.0}})
    H.append({"op": "close", "word": "x", "poss": []})

    # junk helpers
    H.append({"op": "linejunk", "inputs": ["\n", "  #   \n", "hello\n", "#", "", "##\n",
                                           " # x\n", "\t\n", "  ", "x#\n", "#\t \r\n"]})
    H.append({"op": "charjunk", "inputs": [" ", "\t", "\n", "x", "#", ""]})
    return H


# ---------------------------------------------------------- generated cases

_VOCAB = ["def f(x):\n", "    return x\n", "\n", "# note\n", "x = 1\n", "y = 2\n",
          "print(x)\n", "  \n", "pass\n", "import os\n", "if x:\n", "else:\n",
          "    y += 1\n", "class A:\n", "}\n", "{\n"]
_LETTERS = "abcdefghij"


def _mutate_line(rng, line):
    body = line.rstrip("\n")
    if not body:
        return "x" + line
    k = rng.randrange(len(body))
    r = rng.random()
    if r < 0.4:
        body = body[:k] + rng.choice(_LETTERS) + body[k + 1:]
    elif r < 0.7:
        body = body[:k] + rng.choice(_LETTERS + " ") + body[k:]
    else:
        body = body[:k] + body[k + 1:]
    return body + "\n"


def _edit(rng, lines, nedits):
    out = list(lines)
    for _ in range(nedits):
        r = rng.random()
        if r < 0.25 and out:
            k = rng.randrange(len(out))
            del out[k:k + rng.randint(1, 3)]
        elif r < 0.5:
            k = rng.randint(0, len(out))
            out[k:k] = [rng.choice(_VOCAB) for _ in range(rng.randint(1, 3))]
        elif r < 0.85 and out:
            k = rng.randrange(len(out))
            out[k] = _mutate_line(rng, out[k])
        elif len(out) > 1:
            k = rng.randrange(len(out) - 1)
            out[k], out[k + 1] = out[k + 1], out[k]
    return out


def _rand_calls(rng, la, lb):
    calls = [list(c) for c in _ALL]
    rng.shuffle(calls)
    for _ in range(2):
        alo = rng.randint(0, la)
        ahi = rng.randint(alo, la)
        blo = rng.randint(0, lb)
        bhi = rng.randint(blo, lb)
        calls.append(["find_longest_match", alo, ahi, blo, bhi])
    calls.append(["get_grouped_opcodes", rng.choice([0, 1, 2, 3])])
    return calls


def _rand_str(rng, alphabet, lo, hi):
    return "".join(rng.choice(alphabet) for _ in range(rng.randint(lo, hi)))


def _generated():
    rng = random.Random(20261015)
    out = []
    # strings
    for _ in range(16):
        alpha = rng.choice(["ab", "abc", "abcd ", "xyz  q"])
        a = _rand_str(rng, alpha, 0, 25)
        b = _rand_str(rng, alpha, 0, 25)
        c = {"op": "sm", "a": a, "b": b, "calls": _rand_calls(rng, len(a), len(b))}
        if " " in alpha and rng.random() < 0.6:
            c["isjunk"] = "space"
        out.append(c)
    # strings with edits of each other
    for _ in range(8):
        a = _rand_str(rng, "abcdefg ", 10, 40)
        b = _mutate_line(rng, _mutate_line(rng, a + "\n")).rstrip("\n")
        c = {"op": "sm", "a": a, "b": b, "calls": _rand_calls(rng, len(a), len(b))}
        if rng.random() < 0.4:
            c["isjunk"] = rng.choice(["space", "vowel"])
        out.append(c)
    # line lists
    for _ in range(16):
        a = [rng.choice(_VOCAB) for _ in range(rng.randint(0, 20))]
        b = _edit(rng, a, rng.randint(1, 5))
        c = {"op": "sm", "a": a, "b": b, "calls": _rand_calls(rng, len(a), len(b))}
        if rng.random() < 0.4:
            c["isjunk"] = rng.choice(["blank", "IS_LINE_JUNK", "hash"])
        out.append(c)
    # long sequences: popular-element rule
    for i in range(6):
        n = rng.randint(200, 260)
        b = [rng.choice(_VOCAB[:6]) if rng.random() < 0.5 else "u%d\n" % j for j in range(n)]
        a = _edit(rng, b, rng.randint(3, 8))
        c = {"op": "sm", "a": a, "b": b,
             "calls": [["get_matching_blocks"], ["ratio"], ["get_grouped_opcodes", 2]]}
        if i % 2:
            c["autojunk"] = False
        out.append(c)
    for i in range(4):
        b = _rand_str(rng, "aab c", 200, 240)
        a = _rand_str(rng, "abcde", 5, 40)
        c = {"op": "sm", "a": a, "b": b, "calls": [["get_matching_blocks"], ["ratio"], ["quick_ratio"]]}
        if i % 2:
            c["autojunk"] = False
        out.append(c)
    # unified / context
    for i in range(14):
        a = [rng.choice(_VOCAB) for _ in range(rng.randint(0, 25))]
        b = _edit(rng, a, rng.randint(0, 5))
        kw = {}
        if rng.random() < 0.6:
            kw["n"] = rng.choice([0, 1, 2, 3, 5])
        if rng.random() < 0.4:
            kw["fromfile"] = "a/f.py"
            kw["tofile"] = "b/f.py"
        if rng.random() < 0.3:
            kw["fromfiledate"] = "2026-01-0%d" % rng.randint(1, 9)
        if rng.random() < 0.3:
            kw["tofiledate"] = "today"
        if rng.random() < 0.3:
            kw["lineterm"] = ""
            a = [x.rstrip("\n") for x in a]
            b = [x.rstrip("\n") for x in b]
        out.append({"op": "unified" if i % 2 == 0 else "context", "a": a, "b": b, "kwargs": kw})
    # ndiff
    for _ in range(14):
        a = [rng.choice(_VOCAB) for _ in range(rng.randint(0, 10))]
        b = _edit(rng, a, rng.randint(1, 4))
        c = {"op": "ndiff", "a": a, "b": b}
        r = rng.random()
        if r < 0.25:
            c["linejunk"] = "IS_LINE_JUNK"
        elif r < 0.4:
            c["charjunk"] = None
        out.append(c)
    # get_close_matches
    words = ["".join(rng.choice("abcdefg") for _ in range(rng.randint(2, 7))) for _ in range(60)]
    for _ in range(10):
        word = rng.choice(words)
        poss = rng.sample(words, rng.randint(2, 8))
        for _ in range(rng.randint(2, 6)):
            poss.insert(rng.randint(0, len(poss)), _mutate_line(rng, word + "\n").rstrip("\n"))
        kw = {}
        if rng.random() < 0.5:
            kw["n"] = rng.randint(1, 5)
        if rng.random() < 0.5:
            kw["cutoff"] = rng.choice([0.0, 0.3, 0.5, 0.75, 0.9])
        out.append({"op": "close", "word": word, "poss": poss, "kwargs": kw})
    return out


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        c["id"] = "%s-%03d-%s" % (NAME, i, c["op"])
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    if len(argv) != 2:
        print("usage: mod_diff.py <package_root>")
        return 2
    sys.path.insert(0, argv[1])
    try:
        mod = __import__(MODULE, fromlist=["_"])
    except Exception as e:  # noqa: BLE001
        print("%s: import failed: %r" % (NAME, e))
        print("%s: 0/%d" % (NAME, len(cases())))
        return 1
    cs = cases()
    passed = 0
    bad = []
    slowest = (0.0, None)
    for c in cs:
        t0 = time.perf_counter()
        got = json.loads(json.dumps(run_impl(mod, c)))
        dt = time.perf_counter() - t0
        if dt > slowest[0]:
            slowest = (dt, c["id"])
        exp = json.loads(json.dumps(run_oracle(c)))
        if same(got, exp):
            passed += 1
        else:
            bad.append((c, got, exp))
    print("%s: %d/%d" % (NAME, passed, len(cs)))
    print("slowest case: %s %.3fs" % (slowest[1], slowest[0]))
    for c, got, exp in bad[:10]:
        print("MISMATCH %s %s" % (c["id"], json.dumps(c)[:400]))
        print("   got: %s" % json.dumps(got)[:400])
        print("  want: %s" % json.dumps(exp)[:400])
    return 0 if passed == len(cs) else 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
