"""Hidden differential cases for toolkit.regex (graded against `re`).

Adapter interface: NAME, MODULE, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_regex.py <package_root>` runs the
self-test against <package_root>/toolkit/regex.py.

cases() does not import `re`: generated patterns are valid (or invalid) by
construction, and the self-test against the stdlib confirms it.
"""

import random
import sys
import time

NAME = "regex"
MODULE = "toolkit.regex"
# The stdlib imports re everywhere, so the sandbox watches it during regex cases instead of
# refusing it; re._compiler.compile and _sre.compile catch references captured at import time.
ORACLES = ["re", "sre_compile", "sre_parse", "sre_constants", "_sre"]
WRAP = ["re.compile", "re.search", "re.match", "re.fullmatch", "re.split", "re.findall", "re.finditer",
        "re.sub", "re.subn", "re.escape", "re._compile", "re._compiler.compile", "_sre.compile"]

_I, _M, _S = 2, 8, 16

# ----------------------------------------------------------- normalization

_FNS = {
    "upper": lambda m: m.group(0).upper(),
    "bracket": lambda m: "[" + m.group(0) + "]",
    "len": lambda m: str(len(m.group(0))),
    "g1twice": lambda m: (m.group(1) or "") * 2,
    "span": lambda m: "%d-%d" % m.span(),
    "lastindex": lambda m: str(m.lastindex),
}


def _err(e, errcls):
    if errcls is not None and isinstance(e, errcls):
        return {"error": "error"}
    return {"error": type(e).__name__}


def _listify(x):
    if isinstance(x, (list, tuple)):
        return [_listify(v) for v in x]
    if isinstance(x, dict):
        return {k: _listify(v) for k, v in x.items()}
    return x


def _norm_match(m, case, errcls):
    if m is None:
        return None
    ng = len(m.groups())
    r = {
        "span": list(m.span()),
        "start": m.start(),
        "end": m.end(),
        "group0": m.group(0),
        "group": m.group(),
        "groups": list(m.groups()),
        "groups_def": list(m.groups("<none>")),
        "groupdict": dict(m.groupdict()),
        "groupdict_def": dict(m.groupdict("")),
        "spans": [list(m.span(i)) for i in range(ng + 1)],
        "starts": [m.start(i) for i in range(ng + 1)],
        "ends": [m.end(i) for i in range(ng + 1)],
        "lastindex": m.lastindex,
        "lastgroup": m.lastgroup,
        "pos": m.pos,
        "endpos": m.endpos,
        "string_ok": m.string == case["string"],
        "re_pattern": m.re.pattern,
    }
    if ng:
        r["multi"] = list(m.group(*range(ng + 1)))
        r["multi_rev"] = list(m.group(*range(ng, -1, -1)))
    names = sorted(m.groupdict())
    r["by_name"] = {n: [m.group(n), m.start(n), m.end(n), list(m.span(n))] for n in names}
    if "template" in case:
        try:
            r["expand"] = m.expand(case["template"])
        except Exception as e:  # noqa: BLE001
            r["expand"] = _err(e, errcls)
    if "bad_group" in case:
        try:
            r["bad_group"] = m.group(case["bad_group"])
        except Exception as e:  # noqa: BLE001
            r["bad_group"] = _err(e, errcls)
    return r


def _run(mod, case):
    errcls = getattr(mod, "error", None)
    try:
        return _listify(_dispatch(mod, case, errcls))
    except Exception as e:  # noqa: BLE001
        return _err(e, errcls)


def _target(mod, case):
    """Return (callable-provider, use_pattern_api)."""
    if case.get("api", "pattern") == "module":
        return None
    return mod.compile(case["pattern"], case.get("flags", 0))


def _pe(case):
    args = []
    if "pos" in case:
        args.append(case["pos"])
        if "endpos" in case:
            args.append(case["endpos"])
    return args


def _repl(case):
    if "fn" in case:
        return _FNS[case["fn"]]
    return case["repl"]


def _dispatch(mod, case, errcls):
    op = case["op"]
    pat = case.get("pattern")
    flags = case.get("flags", 0)
    s = case.get("string")
    if op == "escape":
        return mod.escape(s)
    if op == "compile":
        p = mod.compile(pat, flags)
        return {"groups": p.groups, "groupindex": dict(p.groupindex),
                "pattern": p.pattern, "flags": p.flags}
    p = _target(mod, case)
    if op in ("search", "match", "fullmatch"):
        if p is None:
            m = getattr(mod, op)(pat, s, flags=flags)
        else:
            m = getattr(p, op)(s, *_pe(case))
        return _norm_match(m, case, errcls)
    if op == "findall":
        if p is None:
            return mod.findall(pat, s, flags=flags)
        return p.findall(s, *_pe(case))
    if op == "finditer":
        if p is None:
            it = mod.finditer(pat, s, flags=flags)
        else:
            it = p.finditer(s, *_pe(case))
        return [_norm_match(m, case, errcls) for m in it]
    if op in ("sub", "subn"):
        repl = _repl(case)
        count = case.get("count", 0)
        if p is None:
            return getattr(mod, op)(pat, repl, s, count=count, flags=flags)
        return getattr(p, op)(repl, s, count)
    if op == "split":
        maxsplit = case.get("maxsplit", 0)
        if p is None:
            return mod.split(pat, s, maxsplit=maxsplit, flags=flags)
        return p.split(s, maxsplit)
    raise ValueError("unknown op %r" % op)


def run_impl(mod, case):
    return _run(mod, case)


def run_oracle(case):
    import re
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return _run(re, case)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

def _hand():
    H = []

    def add(op, pattern, string=None, **kw):
        c = {"op": op, "pattern": pattern}
        if string is not None:
            c["string"] = string
        c.update(kw)
        H.append(c)

    # literals, escapes, dot
    add("findall", r"a\.b\\c", "a.b\\c axb\\c a.b\\c")
    add("search", r"\t\n\x41\101\0", "x\t\nAA\x00y")
    add("findall", r".", "a\nb", flags=_S)
    add("findall", r"a.c", "abc a\nc aXc")
    # character classes
    add("findall", r"[]a-c-]+", "x]a-bcz--")
    add("findall", r"[^]\d]+", "12]ab3c]")
    add("findall", r"[\w.-]+@[\w-]+", "mail: a.b-c@ex-1 and q@w")
    add("findall", r"[\s\S]{2}", "a b\nc")
    add("findall", r"[A-z]+", "ab[\\]^_`CD{")
    add("findall", r"[A-z]+", "ab[\\]^_`CD{", flags=_I)
    add("findall", r"[^a-c]+", "AbCdE", flags=_I)
    add("findall", r"[B-D]+|[^\Wa-x]", "abcdeyz", flags=_I)
    add("findall", r"[\b]+", "a\b\bb")
    # categories
    add("findall", r"\d+|\W+|\s", "ab 12, -x_9\t")
    add("findall", r"\D\S\w", "a1b c_d 9z!")
    add("findall", r"\s+", "a\x1c\x1d b\x0b\x0cc\t")
    # anchors
    add("findall", r"^\w+$", "one\ntwo\nthree\n", flags=_M)
    add("findall", r"^\w+$", "one\ntwo\n")
    add("search", r"\w+$", "abc\n")
    add("search", r"\w+\Z", "abc\n")
    add("findall", r"\A\w|\w\Z", "ab\ncd")
    add("findall", r"\b\w", "it's a dog-cat_x")
    add("findall", r"\B\w", "it's a dog")
    add("findall", r"$", "a\nb\n")
    add("findall", r"$", "a\nb\n", flags=_M)
    add("search", r"\B", "")
    add("findall", r"(?m)^$", "\n\na\n")
    # groups
    add("search", r"(a)(b)?(c)", "xacz")
    add("match", r"(?P<first>\w+) (?P<last>\w+)", "Jane Doe x", template=r"\g<last>, \g<first> (\2)")
    add("search", r"(?:ab)+(c)", "zababcz")
    add("match", r"((a)|b)+", "abab")
    add("match", r"(a)|(b)", "b")
    add("match", r"(?:(a)|b)*", "ab")
    add("match", r"(a?)*", "aa")
    add("match", r"(a*?)+?$", "aa")
    add("match", r"(a|)*b", "aab")
    add("search", r"((a)(b))(c)?", "ab", bad_group=7)
    add("search", r"(?P<x>a)", "a", bad_group="y")
    add("fullmatch", r"(a+)(b*)", "aaab")
    add("fullmatch", r"a|ab", "ab")
    add("fullmatch", r"a+?", "aaa")
    # backreferences
    add("findall", r"(\w)\1", "aabbcd eef")
    add("findall", r"(?P<q>['\"]).*?(?P=q)", "'a' \"b'c\" 'd")
    add("search", r"(a)?b\1", "bab")
    add("findall", r"(a)\1", "aA Aa aa", flags=_I)
    add("search", r"(?P<n>x)(y)\2(?P=n)", "xyyx")
    # alternation and quantifiers
    add("findall", r"cat|category|dog", "category dogcat")
    add("findall", r"a{2}|b{1,2}|c{,2}|d{2,}", "aaabbbcccdddd")
    add("findall", r"a{1,3}?b", "aaab ab")
    add("findall", r"<.+?>|<.+>", "<a><b>")
    add("findall", r"x{,}y", "xxy y")
    add("findall", r"a{x}|a{|a{1", "a{x} a{ a{1}")
    add("findall", r"(?:a|b)??c", "abc c bc")
    add("findall", r"(ab|a)(bc|c)?", "abc abc")
    # lookaround
    add("findall", r"\w+(?=,)", "a,bb,ccc")
    add("findall", r"\b\w+\b(?!\()", "f(x) g y(z)")
    add("findall", r"(?<=\$)\d+", "$10 20 $3")
    add("findall", r"(?<!-)\b\d", "-1 2 -3 4")
    add("findall", r"(?<=ab|cd)e", "abe cde xde")
    add("search", r"(?=(\w+))\w", "hello")
    add("findall", r"(?<=(a))b", "ab cb ab")
    add("findall", r"(?=a)*b", "ab b")
    add("search", r"(?P<x>a)(?<=(?P=x))b", "zab")
    # flags
    add("findall", r"(?i)abc", "ABC aBc abd")
    add("findall", r"(?is)a.b", "A\nB")
    add("findall", r"(?i:a)b", "Ab AB ab")
    add("findall", r"[a-c]+", "ABCabcd", flags=_I)
    add("compile", r"(?im)(?P<w>a)(b)")
    add("compile", r"x", flags=_I | _S)
    add("compile", r"(?P<a>x)|(?P<b>y)(z)")
    # sub/subn/split
    add("sub", r"(\w+)@(\w+)", "a@b, c@d", repl=r"\2 at \1")
    add("sub", r"(?P<k>\w)=(?P<v>\d)", "a=1 b=2", repl=r"\g<v>\g<k>\g<0>")
    add("subn", r"x*", "abxd", repl="-")
    add("sub", r"a|(b)", "abab", repl=r"[\1]")
    add("sub", r"\d", "a1b22c333", repl=r"\\n\n#", count=3)
    add("sub", r"(\d)(\d)?", "1 23 4", fn="g1twice")
    add("subn", r"[aeiou]", "education", fn="upper", count=2)
    add("sub", r"", "abc", fn="span")
    add("split", r"[,;]\s*", "a, b;c,,d")
    add("split", r"(-)|(\+)", "1-2+3")
    add("split", r"x*", "axbc")
    add("split", r"\b", "ab cd")
    add("split", r"\W+", "a b c d", maxsplit=2)
    add("split", r"(a)|b", "xaybz", api="module", maxsplit=1)
    add("findall", r"", "ab")
    add("finditer", r"\w*", "ab c")
    add("finditer", r"(?P<d>\d)|(?P<l>[a-z])", "a1-")
    # pos / endpos
    add("search", r"^b", "ab", pos=1)
    add("search", r"(?<=a)b\b", "abc", pos=1, endpos=2)
    add("match", r"\w+$", "abc def", pos=4, endpos=6)
    add("findall", r"\w", "abcdef", pos=2, endpos=5)
    add("finditer", r"$|\b", "ab cd", pos=1, endpos=4)
    add("fullmatch", r"b+", "abbbc", pos=1, endpos=4)
    add("search", r"c", "abc", pos=-5, endpos=99)
    # module-level api
    add("search", r"(\d+)-(\d+)", "tel 12-345", api="module")
    add("findall", r"(a)(b)?", "ab a", api="module", flags=_I)
    add("sub", r"o", "foo boo", api="module", repl="0", count=2)
    add("subn", r"(?i)O", "fOo", api="module", repl="<\\g<0>>")
    add("fullmatch", r"\w+", "abc", api="module")
    add("match", r"B", "b", api="module", flags=_I)
    add("finditer", r"a(?=b)", "abab", api="module")
    add("escape", None, "a.b*c?d+(e)[f]{g}|h^$\\ -#&~\t\n_9")
    add("escape", None, "plain_text-09")
    # errors in patterns
    for bad in ["a)", "(a", "[a", "a**", "*a", "a{3,2}", r"\q", r"[\q]", r"\2(a)",
                "(?P<a>x)(?P<a>y)", "(?P<1>x)", "(?P=z)", "(?<=a+)b", "(?<=a|bc)",
                "a(?i)b", "[z-a]", r"[a-\d]", r"(a\1)", "(?", "(?<x)", "x|*", "\\",
                r"\x4g", r"\400", "(?P<n>a)(?P=n", "a{2}{3}", r"\b+", "(?z)"]:
        add("compile", bad)
    add("findall", r"(?<=a{1,2})b", "ab")
    add("search", r"(a)(?<=\2)", "aa")
    # errors in templates
    add("sub", r"(a)", "a", repl=r"\2")
    add("sub", r"(a)", "a", repl=r"\g<x>")
    add("sub", r"(?P<x>a)", "a", repl=r"\g<1x>")
    add("sub", r"(a)", "a", repl=r"\q")
    add("sub", r"(a)", "a", repl=r"\g<1")
    add("search", r"(a)", "a", template=r"\g<2>")
    return H


# ---------------------------------------------------------- generated cases

class _Gen:
    LITS = "aabbc"
    CLASSES = ["[ab]", "[^a]", "[a-c]", "[^b\\s]", "[A-C]", "[\\d_]", "[-a]", "[c-]"]
    ESC = ["\\d", "\\w", "\\s", "\\W", "\\D", "\\S"]
    QUANT = ["", "", "", "*", "+", "?", "*?", "+?", "??", "{2}", "{1,2}", "{,2}", "{1,}", "{0,1}?"]
    BOUNDED = ["", "?", "{1,2}", "{,2}", "??", "{2}"]

    def __init__(self, rng):
        self.rng = rng

    def pattern(self):
        self.ngroups = 0
        self.closed = []
        self.names = []
        self.lookbehind = False
        p, _ = self.alt(0)
        return p, self.ngroups

    def alt(self, depth):
        r = self.rng
        n = 1 if r.random() < 0.75 else r.choice([2, 2, 3])
        parts = []
        unb = False
        for _ in range(n):
            s, u = self.seq(depth)
            parts.append(s)
            unb = unb or u
        return "|".join(parts), unb

    def seq(self, depth):
        r = self.rng
        items = []
        unb = False
        for _ in range(r.randint(1, 4 if depth == 0 else 3)):
            s, u = self.item(depth)
            items.append(s)
            unb = unb or u
        return "".join(items), unb

    def item(self, depth):
        r = self.rng
        x = r.random()
        if x < 0.35:
            atom = r.choice(self.LITS)
            return self.quant(atom, False)
        if x < 0.45:
            return self.quant(".", False)
        if x < 0.55:
            return self.quant(r.choice(self.CLASSES), False)
        if x < 0.62:
            return self.quant(r.choice(self.ESC), False)
        if x < 0.70:
            return r.choice(["^", "$", "\\b", "\\B", "\\A", "\\Z"]), False
        if x < 0.76 and self.closed and not self.lookbehind:
            g = r.choice(self.closed)
            if g in self.names and r.random() < 0.5:
                return "(?P=n%d)" % g, False
            return "\\%d" % g, False
        if x < 0.82 and depth < 2:
            kind = r.choice(["(?=", "(?!", "(?<=", "(?<!"])
            if kind.startswith("(?<"):
                w = r.randint(1, 2)
                body = "".join(r.choice(self.LITS + ".") for _ in range(w))
                if r.random() < 0.3:
                    body = body + "|" + "".join(r.choice(self.LITS) for _ in range(w))
                return kind + body + ")", False
            body, _ = self.seq(depth + 1)
            return kind + body + ")", False
        if depth < 2:
            kind = r.choice(["cap", "cap", "nc", "named"])
            if kind == "nc":
                body, unb = self.alt(depth + 1)
                return self.quant("(?:" + body + ")", unb)
            self.ngroups += 1
            g = self.ngroups
            body, unb = self.alt(depth + 1)
            self.closed.append(g)
            if kind == "named":
                self.names.append(g)
                return self.quant("(?P<n%d>" % g + body + ")", unb)
            return self.quant("(" + body + ")", unb)
        return self.quant(r.choice(self.LITS), False)

    def quant(self, atom, inner_unbounded):
        q = self.rng.choice(self.BOUNDED if inner_unbounded else self.QUANT)
        # any quantified item counts: a group whose body is quantified only
        # gets bounded quantifiers, which keeps backtracking polynomial
        return atom + q, inner_unbounded or q != ""

    def subject(self):
        r = self.rng
        alphabet = "aaabbbcc AB1_-\n"
        return "".join(r.choice(alphabet) for _ in range(r.randint(0, 14)))


_CORRUPT = [
    lambda p: p + ")",
    lambda p: "*" + p,
    lambda p: p + "(",
    lambda p: p + "\\q",
    lambda p: p + "a{3,1}",
    lambda p: "(?P<1>" + p + ")",
    lambda p: p + "\\9",
    lambda p: p + "(?<=a*)",
    lambda p: p + "a**",
    lambda p: "x(?s)" + p,
]


def _generated():
    rng = random.Random(1310152026)
    g = _Gen(rng)
    out = []
    ops = ["findall", "findall", "search", "search", "finditer", "sub", "split",
           "match", "fullmatch", "subn"]
    flag_choices = [0, 0, 0, _I, _M, _S, _I | _M, _M | _S]
    while len(out) < 66:
        p, ng = g.pattern()
        c = {"pattern": p, "string": g.subject(), "flags": rng.choice(flag_choices)}
        op = rng.choice(ops)
        c["op"] = op
        if op == "sub" or op == "subn":
            if rng.random() < 0.5:
                refs = "".join("\\%d" % rng.randint(0, ng) for _ in range(rng.randint(0, 2)))
                c["repl"] = "<" + refs + ">"
            else:
                c["fn"] = rng.choice(["bracket", "len", "span", "lastindex"] +
                                     (["g1twice"] if ng else []))
            if rng.random() < 0.3:
                c["count"] = rng.randint(1, 3)
        elif op == "split" and rng.random() < 0.3:
            c["maxsplit"] = rng.randint(1, 2)
        elif op in ("search", "match", "finditer") and rng.random() < 0.3:
            n = len(c["string"])
            c["pos"] = rng.randint(0, n)
            if rng.random() < 0.6:
                c["endpos"] = rng.randint(c["pos"], n)
        if op in ("search", "match", "fullmatch") and ng and rng.random() < 0.5:
            c["template"] = "".join("\\g<%d>-" % rng.randint(0, ng) for _ in range(2))
        if len(out) % 9 == 8:
            c = {"op": "compile", "pattern": rng.choice(_CORRUPT)(p), "flags": c["flags"]}
        out.append(c)
    return out


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        c["id"] = "%s-%03d-%s" % (NAME, i, c["op"])
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    import json
    if len(argv) != 2:
        print("usage: mod_regex.py <package_root>")
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
        print("MISMATCH %s %s" % (c["id"], json.dumps(c)))
        print("   got: %s" % json.dumps(got)[:400])
        print("  want: %s" % json.dumps(exp)[:400])
    return 0 if passed == len(cs) else 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
