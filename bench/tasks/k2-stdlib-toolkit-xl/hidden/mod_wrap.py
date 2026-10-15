"""Hidden differential cases for toolkit.wrap (graded against `textwrap`).

Adapter interface: NAME, MODULE, ORACLES, WRAP, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_wrap.py <package_root>` runs the
self-test against <package_root>/toolkit/wrap.py.

cases() imports neither `textwrap` nor the solution; inputs are generated from
a fixed seed.  All text is ASCII.
"""

import json
import random
import sys
import time

NAME = "wrap"
MODULE = "toolkit.wrap"
ORACLES = ["textwrap"]
WRAP = [
    "textwrap.wrap",
    "textwrap.fill",
    "textwrap.shorten",
    "textwrap.dedent",
    "textwrap.indent",
    "textwrap.TextWrapper",
]

# indent() predicates a case can name (spec/wrap.md lists them).
_PREDS = {
    "always": lambda line: True,
    "never": lambda line: False,
    "hash": lambda line: line.startswith("#"),
    "longer3": lambda line: len(line) > 3,
}


# ----------------------------------------------------------- normalization

def _kind(e):
    return type(e).__name__


def _step(w, step):
    kind = step[0]
    if kind == "set":
        setattr(w, step[1], step[2])
        return None
    try:
        if kind == "wrap":
            return w.wrap(step[1])
        if kind == "fill":
            return w.fill(step[1])
    except Exception as e:  # noqa: BLE001
        return {"error": _kind(e)}
    raise ValueError(kind)


def _run(mod, case):
    op = case["op"]
    kw = case.get("kwargs", {})
    try:
        if op == "wrap":
            return mod.wrap(case["text"], **kw)
        if op == "fill":
            return mod.fill(case["text"], **kw)
        if op == "shorten":
            return mod.shorten(case["text"], case["width"], **kw)
        if op == "dedent":
            return mod.dedent(case["text"])
        if op == "indent":
            if "predicate" in case:
                return mod.indent(case["text"], case["prefix"], _PREDS[case["predicate"]])
            return mod.indent(case["text"], case["prefix"])
        if op == "wrapper":
            w = mod.TextWrapper(**kw)
            return [_step(w, s) for s in case["steps"]]
    except Exception as e:  # noqa: BLE001
        return {"error": _kind(e)}
    raise ValueError(op)


def run_impl(mod, case):
    return _run(mod, case)


def run_oracle(case):
    import textwrap
    return _run(textwrap, case)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

_LOREM = ("The quick brown fox jumps over the lazy dog. Pack my box with five "
          "dozen liquor jugs! How vexingly quick daft zebras jump? Sphinx of "
          "black quartz, judge my vow.")


def _hand():
    H = []

    def W(text, op="wrap", **kw):
        H.append({"op": op, "text": text, "kwargs": kw})

    # basic wrapping and defaults
    W(_LOREM)
    W(_LOREM, width=20)
    W(_LOREM, op="fill", width=33)
    W("")
    W("   ")
    W("   ", drop_whitespace=False)
    W("one", width=1)
    W("a b c d e f g", width=1)
    W("  leading and trailing  ", width=10)
    W("  leading and trailing  ", width=10, drop_whitespace=False)
    W("word " * 12, width=10)
    W("x", width=0)
    W("x", width=-3)
    W("", width=0)
    # indents
    W(_LOREM, width=30, initial_indent="* ", subsequent_indent="  ")
    W(_LOREM, op="fill", width=25, initial_indent=">>>> ", subsequent_indent="... ")
    W("short", width=5, initial_indent="12345")
    W("ab cd ef", width=5, initial_indent="xxxxx", subsequent_indent="yyyy")
    # tabs and whitespace
    W("a\tb\tc\td", width=40)
    W("a\tb\tc\td", width=40, tabsize=4)
    W("a\tb\tc\td", width=40, expand_tabs=False)
    W("a\tb\tc\td", width=40, expand_tabs=False, replace_whitespace=False)
    W("line one\nline two\n\nline\x0bfour\x0cfive\rsix", width=12)
    W("line one\nline two\n\nline four", width=12, replace_whitespace=False)
    W("12345\t1234567\t1", width=50, tabsize=0)
    # sentence endings
    W("Hello there. How are you? Fine! ok. Mr. Smith said \"yes.\" end", width=25,
      fix_sentence_endings=True)
    W("A.B. C. d.\" e.' f.\" g", width=80, fix_sentence_endings=True)
    W("end.  two spaces already. x", width=80, fix_sentence_endings=True)
    W("ends with dot.", fix_sentence_endings=True)
    W("Wait... what?! no. 3. a.", width=80, fix_sentence_endings=True)
    # long words and hyphens
    W("supercalifragilisticexpialidocious is long", width=10)
    W("supercalifragilisticexpialidocious is long", width=10, break_long_words=False)
    W("a well-known self-contained easy-to-use package", width=12)
    W("a well-known self-contained easy-to-use package", width=12, break_on_hyphens=False)
    W("extraordinarily-long-hyphenated-compound-word here", width=15)
    W("extraordinarily-long-hyphenated-compound-word here", width=15, break_on_hyphens=False)
    W("--------------------x", width=6)
    W("a-b-c-d-e-f-g-h-i-j-k", width=5)
    W("ab-cd-ef-gh-ij-kl-mn", width=7)
    W("x-ray re-do co-op e-mail", width=4)
    W("this--is an--em dash--test and so-- on --x", width=8)
    W("Hello--world foo--bar 1--2 a.--b", width=6)
    W("123-456-789 abc-123 a1-b2-c3", width=5)
    W("xx ab_-cd yy __-__ pre-_-post _a-_b-_c", width=7)
    W("well-known!-stuff 'quoted'--dash", width=7)
    # max_lines and placeholder
    W(_LOREM, width=30, max_lines=2)
    W(_LOREM, width=30, max_lines=1)
    W(_LOREM, width=30, max_lines=3, placeholder=" ...")
    W(_LOREM, width=12, max_lines=2, placeholder="~")
    W("Hello  world!", width=12, max_lines=1)
    W("Hello world", width=11, max_lines=1)
    W("one two three four", width=8, max_lines=2, placeholder=" [...]")
    W("aaaaaaaaaaaaaaaaaaa bb", width=10, max_lines=1, placeholder="..")
    W("hello", width=4, max_lines=1, placeholder=" [...]")
    W("hello", width=10, max_lines=2, subsequent_indent="      ", placeholder=" [...]")
    W("hello world", width=10, max_lines=1, initial_indent="     ", placeholder=" [...]")
    W("a b c d e f g h i j", width=5, max_lines=3, initial_indent="> ", subsequent_indent="  ")
    W("word1 word2 word3   ", width=11, max_lines=2)
    W("word1 word2 word3   ", width=11, max_lines=2, drop_whitespace=False)
    W("abc defghijklmnop", width=8, max_lines=2, placeholder=" ...")
    # shorten
    H.append({"op": "shorten", "text": "Hello  world!", "width": 12, "kwargs": {}})
    H.append({"op": "shorten", "text": "Hello  world!", "width": 11, "kwargs": {}})
    H.append({"op": "shorten", "text": "  Hello \n\t world!  ", "width": 80, "kwargs": {}})
    H.append({"op": "shorten", "text": _LOREM, "width": 40, "kwargs": {"placeholder": "..."}})
    H.append({"op": "shorten", "text": _LOREM, "width": 5, "kwargs": {}})
    H.append({"op": "shorten", "text": "", "width": 10, "kwargs": {}})
    H.append({"op": "shorten", "text": "one-two-three-four", "width": 12, "kwargs": {"placeholder": "+"}})
    H.append({"op": "shorten", "text": "abc", "width": 0, "kwargs": {}})
    # dedent
    for t in ["    hello\n      world\n",
              "\thello\n\t\tworld\n",
              "  a\n\tb\n",
              "    x\n  \n    y\n",
              "  x\n\n   \t\n  y",
              "no indent\n    yes\n",
              "   only one line",
              "",
              "\n\n",
              "  \t a\n  \t b\n  \tc\n",
              "    a\r\n    b\r\n",
              "    trailing\n    ",
              " \t mixed\n \t\tmore\n"]:
        H.append({"op": "dedent", "text": t})
    # indent
    for t, prefix, pred in [("a\nb\n\nc\n", "> ", None),
                            ("a\nb\n  \nc", "  ", None),
                            ("a\r\nb\rc\n", "# ", None),
                            ("a\n\n b", "+", "always"),
                            ("a\nb", "+", "never"),
                            ("#x\ny\n#z\n", "!", "hash"),
                            ("ab\nabcd\n\nabcde", "-", "longer3"),
                            ("", "> ", None),
                            ("\t\n \n", "> ", None)]:
        c = {"op": "indent", "text": t, "prefix": prefix}
        if pred:
            c["predicate"] = pred
        H.append(c)
    # TextWrapper objects with attribute changes
    H.append({"op": "wrapper", "kwargs": {"width": 15},
              "steps": [["wrap", _LOREM], ["set", "width", 25], ["fill", _LOREM],
                        ["set", "initial_indent", "- "], ["wrap", "alpha beta gamma delta"],
                        ["set", "max_lines", 2], ["wrap", _LOREM],
                        ["set", "width", 2], ["wrap", "x"]]})
    H.append({"op": "wrapper", "kwargs": {"width": 10, "break_on_hyphens": False,
                                          "break_long_words": False},
              "steps": [["wrap", "anti-disestablishment-ism rocks"],
                        ["set", "break_on_hyphens", True], ["wrap", "anti-disestablishment-ism rocks"],
                        ["set", "break_long_words", True], ["fill", "anti-disestablishment-ism rocks"]]})
    H.append({"op": "wrapper", "kwargs": {"width": 0},
              "steps": [["wrap", ""], ["set", "width", 3], ["wrap", "abcdefg"]]})
    H.append({"op": "wrapper", "kwargs": {"width": 20, "fix_sentence_endings": True,
                                          "tabsize": 2, "placeholder": " <cut>"},
              "steps": [["fill", "One.\tTwo! Three? four. five"],
                        ["set", "max_lines", 1], ["fill", "One.\tTwo! Three? four. five"],
                        ["set", "placeholder", " this placeholder is far too long"],
                        ["wrap", "x"]]})
    return H


# ---------------------------------------------------------- generated cases

_WORDS = ["a", "an", "the", "cat", "sat", "on", "mat", "quickly", "jumped", "over",
          "lazy", "dogs", "and", "then", "slept", "I", "Python", "code", "x",
          "wrapping", "text", "is", "fun", "really"]
_HYPH = ["well-known", "state-of-the-art", "e-mail", "x-ray", "self-aware",
         "re-run", "a-b-c", "long-ish-word", "co-op", "1-2", "end-"]
_LONG = ["internationalization", "antidisestablishmentarianism", "pneumonoultramicroscopic",
         "aaaaaaaaaaaaaaaaaaaaaaaaa"]
_ENDS = [".", "!", "?", ".\"", "!'", ",", ";", ":", "--"]


def _text(rng):
    parts = []
    for _ in range(rng.randint(1, 30)):
        r = rng.random()
        if r < 0.62:
            w = rng.choice(_WORDS)
        elif r < 0.8:
            w = rng.choice(_HYPH)
        elif r < 0.88:
            w = rng.choice(_LONG)
        else:
            w = "".join(rng.choice("ab-") for _ in range(rng.randint(2, 8)))
        if rng.random() < 0.2:
            w += rng.choice(_ENDS)
        parts.append(w)
        parts.append(rng.choice([" ", " ", " ", " ", "  ", "\t", "\n", " \n "]))
    if rng.random() < 0.5:
        parts.pop()
    text = "".join(parts)
    if rng.random() < 0.15:
        text = "  " + text
    return text


def _opts(rng):
    kw = {"width": rng.choice([1, 2, 5, 8, 10, 12, 15, 20, 30, 45, 70])}
    if rng.random() < 0.25:
        kw["initial_indent"] = rng.choice(["", "* ", "    ", "> > "])
    if rng.random() < 0.25:
        kw["subsequent_indent"] = rng.choice(["", "  ", "| ", "\t"])
    for key, p in (("expand_tabs", 0.15), ("replace_whitespace", 0.15),
                   ("break_long_words", 0.25), ("drop_whitespace", 0.2),
                   ("break_on_hyphens", 0.25)):
        if rng.random() < p:
            kw[key] = False
    if rng.random() < 0.25:
        kw["fix_sentence_endings"] = True
    if rng.random() < 0.2:
        kw["tabsize"] = rng.choice([0, 1, 3, 4])
    if rng.random() < 0.3:
        kw["max_lines"] = rng.choice([1, 2, 3, 5])
        if rng.random() < 0.5:
            kw["placeholder"] = rng.choice(["...", " ~", " [more]", ""])
    # textwrap can loop forever when an indent is longer than width, so the
    # tests never use one (spec/wrap.md)
    for key in ("initial_indent", "subsequent_indent"):
        if len(kw.get(key, "")) > kw["width"]:
            del kw[key]
    return kw


def _generated():
    rng = random.Random(15102026)
    out = []
    for i in range(48):
        out.append({"op": "fill" if i % 3 == 0 else "wrap", "text": _text(rng),
                    "kwargs": _opts(rng)})
    for _ in range(8):
        kw = {}
        if rng.random() < 0.4:
            kw["placeholder"] = rng.choice(["...", " ~", " [more]"])
        if rng.random() < 0.3:
            kw["break_long_words"] = False
        out.append({"op": "shorten", "text": _text(rng), "width": rng.choice([6, 10, 15, 25, 40]),
                    "kwargs": kw})
    for _ in range(6):
        lines = []
        base = rng.choice(["", " ", "  ", "\t", "    ", " \t"])
        for _ in range(rng.randint(1, 6)):
            r = rng.random()
            if r < 0.15:
                lines.append("")
            elif r < 0.25:
                lines.append(rng.choice([" ", "  ", "\t", " \t "]))
            else:
                extra = rng.choice(["", "", " ", "  ", "\t", " \t"])
                lines.append(base + extra + rng.choice(_WORDS))
        out.append({"op": "dedent", "text": "\n".join(lines) + rng.choice(["", "\n"])})
    for _ in range(4):
        lines = [rng.choice(["", " ", "#c", "word", "ab", "x y z"]) for _ in range(rng.randint(1, 6))]
        c = {"op": "indent", "text": "\n".join(lines) + rng.choice(["", "\n"]),
             "prefix": rng.choice(["> ", "\t", "--"])}
        if rng.random() < 0.5:
            c["predicate"] = rng.choice(sorted(_PREDS))
        out.append(c)
    return out


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        c["id"] = "%s-%03d-%s" % (NAME, i, c["op"])
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    if len(argv) != 2:
        print("usage: mod_wrap.py <package_root>")
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
