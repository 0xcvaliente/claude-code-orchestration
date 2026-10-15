"""Hidden differential cases for toolkit.urls (graded against `urllib.parse`).

Adapter interface: NAME, MODULE, ORACLES, WRAP, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_urls.py <package_root>` runs the
self-test against <package_root>/toolkit/urls.py.

cases() imports neither `urllib` nor the solution; inputs come from a fixed
seed.  Values in cases are JSON: {"$b": [ints]} is bytes, {"$ba": [ints]}
bytearray, {"$t": [...]} a tuple, {"$d": [[k, v], ...]} a dict.
"""

import json
import random
import sys
import time

NAME = "urls"
MODULE = "toolkit.urls"
ORACLES = ["urllib.parse"]
WRAP = ["urllib.parse.urlsplit", "urllib.parse.urlparse", "urllib.parse.urlunsplit",
        "urllib.parse.urlunparse", "urllib.parse.urljoin", "urllib.parse.urldefrag",
        "urllib.parse.quote", "urllib.parse.quote_plus", "urllib.parse.quote_from_bytes",
        "urllib.parse.unquote", "urllib.parse.unquote_plus",
        "urllib.parse.unquote_to_bytes", "urllib.parse.urlencode",
        "urllib.parse.parse_qs", "urllib.parse.parse_qsl"]


# ----------------------------------------------------------- normalization

def _dec(v):
    if isinstance(v, list):
        return [_dec(x) for x in v]
    if isinstance(v, dict):
        if "$b" in v:
            return bytes(v["$b"])
        if "$ba" in v:
            return bytearray(v["$ba"])
        if "$t" in v:
            return tuple(_dec(x) for x in v["$t"])
        if "$d" in v:
            return {_dec(k): _dec(x) for k, x in v["$d"]}
        return {k: _dec(x) for k, x in v.items()}
    return v


def _enc(v):
    if isinstance(v, (bytes, bytearray)):
        return {"$" + type(v).__name__: bytes(v).decode("latin-1")}
    if isinstance(v, (list, tuple)):
        return [_enc(x) for x in v]
    if isinstance(v, dict):
        return {"$dict": [[_enc(k), _enc(x)] for k, x in v.items()]}
    if v is None or isinstance(v, (str, int, bool)):
        return v
    return {"$type": type(v).__name__}


def _kind(e):
    if isinstance(e, UnicodeError):
        return {"error": "UnicodeError"}
    for k in (ValueError, TypeError):
        if isinstance(e, k):
            return {"error": k.__name__}
    return {"error": type(e).__name__}


def _attr(r, name):
    try:
        return _enc(getattr(r, name))
    except Exception as e:  # noqa: BLE001
        return _kind(e)


_SPLIT = ("scheme", "netloc", "path", "query", "fragment")
_PARSE = ("scheme", "netloc", "path", "params", "query", "fragment")


def _norm_result(fn, r):
    out = {"is_tuple": isinstance(r, tuple), "items": _enc(list(r))}
    if fn == "urldefrag":
        names = ("url", "fragment")
    else:
        names = (_PARSE if fn == "urlparse" else _SPLIT) + (
            "username", "password", "hostname", "port")
    for n in names:
        out[n] = _attr(r, n)
    try:
        out["geturl"] = _enc(r.geturl())
    except Exception as e:  # noqa: BLE001
        out["geturl"] = _kind(e)
    return out


def _run(mod, case):
    op = case["op"]
    try:
        if op == "call":
            fn = case["fn"]
            args = _dec(case.get("args", []))
            kwargs = _dec(case.get("kwargs", {}))
            if "quote_via" in kwargs:
                kwargs["quote_via"] = getattr(mod, kwargs["quote_via"])
            r = getattr(mod, fn)(*args, **kwargs)
            if fn in ("urlsplit", "urlparse", "urldefrag"):
                return _norm_result(fn, r)
            return {"value": _enc(r), "type": type(r).__name__}
        if op == "roundtrip":
            url = case["url"]
            s = mod.urlsplit(url)
            p = mod.urlparse(url)
            return {"unsplit": mod.urlunsplit(s), "unparse": mod.urlunparse(p),
                    "unsplit_list": mod.urlunsplit(list(s)),
                    "geturl": [s.geturl(), p.geturl()]}
    except Exception as e:  # noqa: BLE001
        return _kind(e)
    raise ValueError(op)


def run_impl(mod, case):
    return _run(mod, case)


def run_oracle(case):
    import urllib.parse
    return _run(urllib.parse, case)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

def _B(s):
    return {"$b": list(s.encode("latin-1"))}


def _hand():
    H = []

    def C(fn, *args, **kwargs):
        H.append({"op": "call", "fn": fn, "args": list(args), "kwargs": kwargs})

    # urlsplit / urlparse basics and attributes
    C("urlsplit", "HTTP://User:Pw@Example.COM:8080/a/b;p?q=1&r=2#frag")
    C("urlparse", "http://user:pw@Example.COM:8080/a/b;x=1/c;y=2?q#f")
    C("urlparse", "http://h/a;b;c")
    C("urlparse", "mailto:a@b.c;x?subject=hi")
    C("urlparse", "sip:alice@host;transport=tcp")
    C("urlparse", "foo://h/p;q")
    C("urlparse", "/rel/path;par?x")
    C("urlsplit", "//host:/p")
    C("urlsplit", "//host:65535")
    C("urlsplit", "//host:65536")
    C("urlsplit", "//host:-1")
    C("urlsplit", "//u@host:080")
    C("urlsplit", "//a:b:c@d@host:1")
    C("urlsplit", "//user@")
    C("urlsplit", "http://[::1]:80/x")
    C("urlsplit", "http://u@[FE80:0:0:0:0:0:0:1]:9/")
    C("urlsplit", "http://[::ffff:192.0.2.1]/")
    C("urlsplit", "http://[v1.fe:Ab]/")
    C("urlsplit", "http://[vz.1]/")
    C("urlsplit", "http://[1.2.3.4]/")
    C("urlsplit", "http://[::1/")
    C("urlsplit", "http://x[::1]/")
    C("urlsplit", "http://[::1]x/")
    C("urlsplit", "http://[1::2::3]/")
    C("urlsplit", "http://[12345::]/")
    C("urlsplit", "http://[::1.2.3.04]/")
    C("urlsplit", "  \x01http://h/p q ")
    C("urlsplit", "ht\ttp://h\n/p\r#f")
    C("urlsplit", "path/only?x#y", "https")
    C("urlsplit", "http://h/p", " ftp\n")
    C("urlsplit", "http://h/p#a#b?c")
    C("urlsplit", "http://h/p#f?q", allow_fragments=False)
    C("urlparse", "http://h/p;x#f", allow_fragments=False)
    C("urlsplit", "1http://h/p")
    C("urlsplit", "Svn+SSH://h/p")
    C("urlsplit", ":foo")
    C("urlsplit", "localhost:8080/x")
    C("urlsplit", "")
    C("urlsplit", "file:///etc/hosts")
    # urlunsplit / urlunparse
    C("urlunsplit", ["http", "h", "p", "q", "f"])
    C("urlunsplit", ["", "", "//p", "", ""])
    C("urlunsplit", ["mailto", "", "a@b", "", ""])
    C("urlunsplit", ["foo", "", "/p", "", ""])
    C("urlunsplit", {"$t": ["git", "", "/r", "", "x"]})
    C("urlunparse", ["http", "h", "/p", "a=1", "q", "f"])
    C("urlunparse", ["", "", "p", "par", "", ""])
    H.append({"op": "roundtrip", "url": "http:/p?#"})
    H.append({"op": "roundtrip", "url": "telnet:x"})
    # urljoin, RFC 3986 section 5.4 examples and scheme rules
    base = "http://a/b/c/d;p?q"
    for rel in ["g:h", "./g", "//g", "?y", "#s", "g?y#s", ";x", "", ".", "../",
                "../..", "../../../../g", "/./g", "g..", "./g/.", "g;x=1/../y",
                "http:g"]:
        C("urljoin", base, rel)
    C("urljoin", "http://a/b/", "a//b/../c")
    C("urljoin", "", "rel/x")
    C("urljoin", "https://a/b/c", "http://a/x")
    C("urljoin", "mailto:a@b", "c@d")
    C("urljoin", "foo://a/b/c", "d")
    C("urljoin", "telnet://h/a/b", "c")
    C("urljoin", "svn+ssh://h/a/b", "../c")
    C("urljoin", "tel:123", "456")
    C("urljoin", "http://a/b/c", "g#s", allow_fragments=False)
    C("urljoin", "a/b/c", "../../../x")
    # urldefrag
    C("urldefrag", "http://h/p;a?q#frag")
    C("urldefrag", "http://h/p?q")
    C("urldefrag", "rel#a#b")
    # quote family
    C("quote", "/a b/c?d=e&f#g~h")
    C("quote", "a/b:c@d", safe=":@")
    C("quote", "a/b", safe=_B("ab"))
    C("quote", "café €")
    C("quote", "café", encoding="latin-1")
    C("quote", "€", encoding="latin-1", errors="replace")
    C("quote", "€", encoding="ascii")
    C("quote", "aé", safe="é")
    C("quote", _B("a b\x00\xff/"))
    C("quote", _B("x y"), encoding="utf-8")
    C("quote", 5)
    C("quote_plus", "a b+c/d")
    C("quote_plus", _B("a b"), safe=_B("&"))
    C("quote_from_bytes", _B("a/b c"), safe=_B(" \xff"))
    C("quote_from_bytes", {"$ba": [97, 32]})
    C("quote_from_bytes", "abc")
    # unquote family
    C("unquote", "abc%20def%2Fg%2fh")
    C("unquote", "%E2%82")
    C("unquote", "%E2%82", errors="strict")
    C("unquote", "%E9t%E9", encoding="latin-1")
    C("unquote", "%zz%4%%41%")
    C("unquote", "%C3é%A9")
    C("unquote", _B("a%20b%C3%A9"))
    C("unquote", 7)
    C("unquote_plus", "a+b%2Bc+%20")
    C("unquote_plus", _B("a+b"))
    C("unquote_to_bytes", "a%20b%ZZ%e9%")
    C("unquote_to_bytes", "é%41")
    C("unquote_to_bytes", _B("x%2B%2b"))
    # urlencode
    C("urlencode", {"$d": [["a", "1"], ["b c", "d&e"], ["f", 3]]})
    C("urlencode", [{"$t": ["x", "1"]}, {"$t": ["x", "2"]}, {"$t": ["y", None]}])
    C("urlencode", {"$d": [["k", ["a", "b"]], ["t", {"$t": [1, 2]}], ["s", "str"],
                           ["n", 5], ["e", []]]}, doseq=True)
    C("urlencode", {"$d": [["k", ["a", "b"]]]})
    C("urlencode", {"$d": [[_B("k\xff"), _B("v w")], ["z", _B("1")]]})
    C("urlencode", {"$d": [["a/b", "c/d e"]]}, safe="/")
    C("urlencode", {"$d": [["a b", "c/d"]]}, quote_via="quote", safe="/")
    C("urlencode", {"$d": [["k", "é"]]}, encoding="latin-1")
    C("urlencode", [["a", "1"]])
    C("urlencode", 5)
    # parse_qs / parse_qsl
    C("parse_qsl", "a=1&&b&c=&=d&e=f=g")
    C("parse_qsl", "a=1&&b&c=&=d", keep_blank_values=True)
    C("parse_qsl", "a=1&b", strict_parsing=True)
    C("parse_qsl", "a=1&&b=2", strict_parsing=True)
    C("parse_qsl", "a+b=c+d%2B%20&%E9=%C3%A9")
    C("parse_qsl", "k=%E9", errors="strict")
    C("parse_qsl", "a=1;b=2&c=3", separator=";")
    C("parse_qsl", "a=1&b=2", separator="")
    C("parse_qsl", "a=1&b=2", separator=1)
    C("parse_qsl", "a=1&b=2&c=3", max_num_fields=2)
    C("parse_qsl", "", max_num_fields=0)
    C("parse_qsl", _B("a=1&b=%41+x&c"))
    C("parse_qsl", "a=1;b=2", separator=_B(";"))
    C("parse_qs", "a=1&b=2&a=3&c=&a=", keep_blank_values=True)
    C("parse_qs", "x&y=1", strict_parsing=True)
    C("parse_qs", _B("k=v&k=w"))
    return H


# ---------------------------------------------------------- generated cases

_SCHEMES = ["http", "https", "ftp", "file", "mailto", "foo", "svn+ssh", "git",
            "tel", "sip", "HTTP", "news", ""]
_HOSTS = ["a", "Ex.COM", "u:p@h", "u@h:80", "h:", "h:99999", "[::1]", "[::1]:8",
          "@h", ""]
_SEGS = ["a", "b", ".", "..", "", "c;p", "d;x=1", "%2F", "~u", "e.f"]


def _gen_url(rng):
    parts = []
    s = rng.choice(_SCHEMES)
    if s:
        parts.append(s + ":")
    if rng.random() < 0.6:
        parts.append("//" + rng.choice(_HOSTS))
    path = "/".join(rng.choice(_SEGS) for _ in range(rng.randint(0, 4)))
    if rng.random() < 0.5:
        path = "/" + path
    parts.append(path)
    if rng.random() < 0.4:
        parts.append("?" + rng.choice(["", "a=1", "x=y&z", "q;r"]))
    if rng.random() < 0.3:
        parts.append("#" + rng.choice(["", "f", "g?h", "i#j"]))
    return "".join(parts)


def _gen_rel(rng):
    segs = [rng.choice(["..", ".", "g", "h", "", "k;p"]) for _ in range(rng.randint(1, 4))]
    rel = "/".join(segs)
    r = rng.random()
    if r < 0.15:
        rel = "/" + rel
    elif r < 0.25:
        rel = "//x/" + rel
    elif r < 0.3:
        rel = rng.choice(["http:", "ftp:", "foo:"]) + rel
    if rng.random() < 0.25:
        rel += rng.choice(["?q", "?", "#f", "?a#b"])
    return rel


_QCHARS = "ab ~/+%?&=:@\u00e9\u20ac-_."


def _gen_quote(rng):
    s = "".join(rng.choice(_QCHARS) for _ in range(rng.randint(0, 10)))
    fn = rng.choice(["quote", "quote_plus"])
    kw = {}
    if rng.random() < 0.5:
        kw["safe"] = rng.choice(["", "/", "+&", ":/?=", "\u00e9"])
    if rng.random() < 0.4:
        return {"op": "call", "fn": fn, "args": [_B(s.encode("utf-8").decode("latin-1"))],
                "kwargs": kw}
    return {"op": "call", "fn": fn, "args": [s], "kwargs": kw}


_UTOK = ["a", "+", "%20", "%2b", "%2B", "%", "%4", "%zz", "%E2%82%AC", "%C3%A9",
         "%E2%82", "%ff", "/", " ", "%25"]


def _gen_unquote(rng):
    s = "".join(rng.choice(_UTOK) for _ in range(rng.randint(0, 6)))
    fn = rng.choice(["unquote", "unquote_plus", "unquote_to_bytes"])
    if fn == "unquote_to_bytes" or rng.random() < 0.8:
        return {"op": "call", "fn": fn, "args": [s], "kwargs": {}}
    return {"op": "call", "fn": fn, "args": [s],
            "kwargs": {"encoding": "latin-1"}}


_QSTOK = ["a=1", "b=", "c", "=d", "a=2", "e=f=g", "x+y=%41+", "", "k=%E9", ";", "z=%2B"]


def _gen_qs(rng):
    sep = rng.choice(["&", "&", ";"])
    s = sep.join(rng.choice(_QSTOK) for _ in range(rng.randint(1, 5)))
    kw = {}
    if rng.random() < 0.5:
        kw["keep_blank_values"] = True
    if rng.random() < 0.3:
        kw["strict_parsing"] = True
    if sep != "&":
        kw["separator"] = sep
    if rng.random() < 0.2:
        kw["max_num_fields"] = rng.randint(1, 5)
    return {"op": "call", "fn": rng.choice(["parse_qsl", "parse_qs"]), "args": [s],
            "kwargs": kw}


def _gen_encode(rng):
    pairs = []
    for _ in range(rng.randint(1, 3)):
        k = rng.choice(["a", "b c", "d&e", "\u00e9"])
        v = rng.choice(["1", "x y", "+/", 7, None, ["p", "q r"], {"$t": ["s", 2]}, []])
        pairs.append([k, v])
    kw = {}
    if rng.random() < 0.5:
        kw["doseq"] = True
    if rng.random() < 0.3:
        kw["quote_via"] = "quote"
    if rng.random() < 0.3:
        kw["safe"] = "/+"
    return {"op": "call", "fn": "urlencode", "args": [{"$d": pairs}], "kwargs": kw}


def _generated():
    rng = random.Random(20261015)
    out = []
    for i in range(5):
        out.append({"op": "call", "fn": rng.choice(["urlsplit", "urlparse"]),
                    "args": [_gen_url(rng)], "kwargs": {}})
    for i in range(6):
        out.append({"op": "call", "fn": "urljoin",
                    "args": [_gen_url(rng), _gen_rel(rng)], "kwargs": {}})
    for i in range(2):
        out.append({"op": "roundtrip", "url": _gen_url(rng)})
    for i in range(3):
        out.append(_gen_quote(rng))
    for i in range(3):
        out.append(_gen_unquote(rng))
    for i in range(3):
        out.append(_gen_qs(rng))
    for i in range(2):
        out.append(_gen_encode(rng))
    return out


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        c["id"] = "%s-%03d-%s" % (NAME, i, c.get("fn", c["op"]))
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    if len(argv) != 2:
        print("usage: mod_urls.py <package_root>")
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
    print("slowest case: %s %.4fs" % (slowest[1], slowest[0]))
    for c, got, exp in bad[:10]:
        print("MISMATCH %s %s" % (c["id"], json.dumps(c)[:300]))
        print("   got: %s" % json.dumps(got)[:400])
        print("  want: %s" % json.dumps(exp)[:400])
    return 0 if passed == len(cs) else 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
