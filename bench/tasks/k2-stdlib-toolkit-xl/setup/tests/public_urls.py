"""Public examples for toolkit.urls, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_urls.py
"""

import os
import sys

EXAMPLES = [
    {"fn": "urlsplit", "args": ["https://Bob:s3cret@WWW.Example.org:443/x/y?a=1#top"]},
    {"fn": "urlparse", "args": ["http://h/dir/file;v=2?k=v"]},
    {"fn": "urlsplit", "args": ["http://[::1]oops/"]},
    {"fn": "urljoin", "args": ["http://a/b/c/d;p?q", "../../e?f"]},
    {"fn": "urljoin", "args": ["mailto:x@y", "z"]},
    {"fn": "urlunsplit", "args": [["file", "", "/tmp/x", "", ""]]},
    {"fn": "quote", "args": ["a b&c/ü"], "kwargs": {"safe": "&"}},
    {"fn": "unquote_plus", "args": ["x+%26+%C3%BC"]},
    {"fn": "urlencode", "args": [[("q", "a b"), ("n", 2)]]},
    {"fn": "parse_qs", "args": ["a=1&b=&a=2"], "kwargs": {"keep_blank_values": True}},
]


def _norm(mod, ex):
    try:
        r = getattr(mod, ex["fn"])(*ex["args"], **ex.get("kwargs", {}))
        if ex["fn"] in ("urlsplit", "urlparse"):
            out = [list(r), r.geturl(), r.username, r.password, r.hostname]
            try:
                out.append(r.port)
            except ValueError:
                out.append("port:ValueError")
            return out
        return r
    except ValueError:
        return "ValueError"
    except TypeError:
        return "TypeError"


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.urls as mod
    import urllib.parse
    got = _norm(mod, ex)
    want = _norm(urllib.parse, ex)
    return got == want, "got %r want %r" % (got, want)


if __name__ == "__main__":
    ok = 0
    for ex in EXAMPLES:
        try:
            r = check(ex)[0]
        except Exception as e:  # noqa: BLE001
            r = False
            print("crash:", ex, repr(e))
        print("PASS" if r else "FAIL", ex)
        ok += bool(r)
    print("urls public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
