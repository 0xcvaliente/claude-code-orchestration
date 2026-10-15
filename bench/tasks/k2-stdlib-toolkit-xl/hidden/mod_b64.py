"""Hidden differential cases for toolkit.b64 (graded against `base64`).

Adapter interface: NAME, MODULE, ORACLES, WRAP, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_b64.py <package_root>` runs the
self-test against <package_root>/toolkit/b64.py.

cases() imports neither `base64` nor `binascii` nor the solution; inputs
come from a fixed seed.  Values in cases are JSON: {"$b": [ints]} is bytes,
{"$ba": [ints]} a bytearray, {"$mv": [ints]} a memoryview over bytes; plain
strings are str arguments.
"""

import json
import random
import sys
import time

NAME = "b64"
MODULE = "toolkit.b64"
ORACLES = ["base64", "binascii"]
WRAP = ["base64.b64encode", "base64.b64decode", "base64.standard_b64encode",
        "base64.standard_b64decode", "base64.urlsafe_b64encode",
        "base64.urlsafe_b64decode", "base64.b32encode", "base64.b32decode",
        "base64.b32hexencode", "base64.b32hexdecode", "base64.b16encode",
        "base64.b16decode", "base64.a85encode", "base64.a85decode",
        "base64.b85encode", "base64.b85decode", "base64.z85encode",
        "base64.z85decode", "base64.encodebytes", "base64.decodebytes",
        "binascii.a2b_base64", "binascii.b2a_base64", "binascii.hexlify",
        "binascii.unhexlify"]


# ----------------------------------------------------------- normalization

def _dec(v):
    if isinstance(v, list):
        return [_dec(x) for x in v]
    if isinstance(v, dict):
        if "$b" in v:
            return bytes(v["$b"])
        if "$ba" in v:
            return bytearray(v["$ba"])
        if "$mv" in v:
            return memoryview(bytes(v["$mv"]))
        return {k: _dec(x) for k, x in v.items()}
    return v


def _enc(v):
    if isinstance(v, (bytes, bytearray)):
        return {"$" + type(v).__name__: bytes(v).decode("latin-1")}
    if v is None or isinstance(v, (str, int, bool)):
        return v
    return {"$type": type(v).__name__}


def _kind(e, errcls):
    if errcls is not None and isinstance(e, errcls):
        return {"error": "Error"}
    for k in (ValueError, TypeError):
        if isinstance(e, k):
            return {"error": k.__name__}
    return {"error": type(e).__name__}


def _run(mod, case, errcls):
    try:
        r = getattr(mod, case["fn"])(*_dec(case.get("args", [])),
                                     **_dec(case.get("kwargs", {})))
        return {"value": _enc(r)}
    except Exception as e:  # noqa: BLE001
        return _kind(e, errcls)


def run_impl(mod, case):
    return _run(mod, case, getattr(mod, "Error", None))


def run_oracle(case):
    import base64
    import binascii
    return _run(base64, case, binascii.Error)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

def _B(s):
    return {"$b": list(s.encode("latin-1"))}


def _hand():
    H = []

    def C(fn, *args, **kwargs):
        H.append({"op": "call", "fn": fn, "args": list(args), "kwargs": kwargs})

    # base64 encode
    C("b64encode", _B(""))
    C("b64encode", _B("\xfb\xff\xfe"))
    C("b64encode", _B("\xfb\xff\xbf?"), altchars=_B("-_"))
    C("b64encode", {"$ba": [0, 1, 2, 3, 4]})
    C("b64encode", {"$mv": [250, 251]})
    C("b64encode", "abc")
    C("b64encode", 3)
    C("standard_b64encode", _B("hello world"))
    C("urlsafe_b64encode", _B("\xfb\xff\xbf"))
    # base64 decode, non-strict
    C("b64decode", _B("aGVsbG8="))
    C("b64decode", "aGVsbG8gd29ybGQ=")
    C("b64decode", "aGVs\nbG8g!d29y*bGQ=")
    C("b64decode", "aGVsb")
    C("b64decode", "YQ")
    C("b64decode", "YQ=")
    C("b64decode", "YQ===")
    C("b64decode", "Y=Q==")
    C("b64decode", "=YQ==")
    C("b64decode", "YW=I")
    C("b64decode", "YQ=a=")
    C("b64decode", "")
    C("b64decode", "YR==")
    C("b64decode", "café")
    C("b64decode", 12)
    C("b64decode", {"$mv": list(b"YWI=")})
    C("b64decode", "-_-_", altchars="-_")
    C("b64decode", "+/-_", altchars=_B("-_"))
    # base64 decode, validate=True
    C("b64decode", "aGVsbG8=", validate=True)
    C("b64decode", "aGVs bG8=", validate=True)
    C("b64decode", "=aGVs", validate=True)
    C("b64decode", "YWJj=", validate=True)
    C("b64decode", "YQ==YQ==", validate=True)
    C("b64decode", "YQ=a=", validate=True)
    C("b64decode", "YWJjY", validate=True)
    C("b64decode", "-_8=", altchars="-_", validate=True)
    C("b64decode", "+_8=", altchars="-_", validate=True)
    C("standard_b64decode", "aGk=")
    C("urlsafe_b64decode", "-_-_")
    C("urlsafe_b64decode", "+/+/")
    C("urlsafe_b64decode", _B("-_8="))
    # encodebytes / decodebytes
    C("encodebytes", _B(""))
    C("encodebytes", _B("x" * 57))
    C("encodebytes", _B("y" * 58))
    C("encodebytes", "text")
    C("encodebytes", {"$ba": [1, 2, 3]})
    C("decodebytes", _B("eHh4\neHh4\n"))
    C("decodebytes", "eHh4")
    C("decodebytes", {"$mv": list(b"YWJj")})
    # base32
    C("b32encode", _B(""))
    C("b32encode", _B("a"))
    C("b32encode", _B("ab"))
    C("b32encode", _B("abc"))
    C("b32encode", _B("abcd"))
    C("b32encode", _B("abcde\xff"))
    C("b32encode", "str")
    C("b32decode", "MFRGGZDF")
    C("b32decode", "ME======")
    C("b32decode", "MFRA====")
    C("b32decode", "MFRGG===")
    C("b32decode", "MFRGGZA=")
    C("b32decode", "MFRGGZ==")
    C("b32decode", "M=======")
    C("b32decode", "========")
    C("b32decode", "MFRGG")
    C("b32decode", "MFRG=GZA")
    C("b32decode", "mfrggzdf")
    C("b32decode", "mfrggzdf", casefold=True)
    C("b32decode", "MFRGGZD1")
    C("b32decode", "0FRGGZD1", map01="L")
    C("b32decode", "0FRGGZD1", map01=_B("I"))
    C("b32decode", "0frggzd1", casefold=True, map01="l")
    C("b32decode", "0FRGGZD1", map01="l")
    C("b32hexencode", _B("abcde\x01"))
    C("b32hexdecode", "C5H66P35")
    C("b32hexdecode", "c5h66p35", casefold=True)
    C("b32hexdecode", "c5h66p35")
    C("b32hexdecode", "C4======")
    # base16
    C("b16encode", _B("\x00\x9a\xff"))
    C("b16encode", "ab")
    C("b16decode", "009AFF")
    C("b16decode", "009aff")
    C("b16decode", "009aff", casefold=True)
    C("b16decode", "ABC")
    C("b16decode", "0G")
    C("b16decode", "00 11")
    # ascii85
    C("a85encode", _B("hello world"))
    C("a85encode", _B("\x00\x00\x00\x00ab\x00\x00\x00\x00"))
    C("a85encode", _B("\x00"))
    C("a85encode", _B("\x00"), pad=True)
    C("a85encode", _B("    x    "))
    C("a85encode", _B("    x    "), foldspaces=True)
    C("a85encode", _B("abcdefghij"), wrapcol=4)
    C("a85encode", _B("abcdefgh"), adobe=True)
    C("a85encode", _B("abcdefgh"), adobe=True, wrapcol=1)
    C("a85encode", _B("abcdefg"), adobe=True, wrapcol=5)
    C("a85encode", _B(""), adobe=True, wrapcol=3)
    C("a85encode", "abc")
    C("a85decode", "BOu!rDZ")
    C("a85decode", "z!!")
    C("a85decode", "!z")
    C("a85decode", "y", foldspaces=True)
    C("a85decode", "y")
    C("a85decode", "+<y", foldspaces=True)
    C("a85decode", "s8W-\"")
    C("a85decode", "s8W-!")
    C("a85decode", "BOu !\nrD\tZ")
    C("a85decode", "BOu!x")
    C("a85decode", "BOu !rDZ", ignorechars=_B("\n"))
    C("a85decode", "BOu_!rDZ", ignorechars=_B("_"))
    C("a85decode", "<~BOu!rDZ~>", adobe=True)
    C("a85decode", "BOu!rDZ~>", adobe=True)
    C("a85decode", "<~BOu!rDZ", adobe=True)
    C("a85decode", "<~BOu!rDZ~>")
    C("a85decode", "B")
    C("a85decode", "café")
    # base85 / z85
    C("b85encode", _B("hello world"))
    C("b85encode", _B("\x00\x00\x00\x00"))
    C("b85encode", _B("abcde"))
    C("b85encode", _B("abcde"), pad=True)
    C("b85encode", "abc")
    C("b85decode", "Xk~0{Zy<MXa%^NF")
    C("b85decode", "X")
    C("b85decode", "Xk~0 ")
    C("b85decode", "|NsC0")
    C("b85decode", "|NsC1")
    C("z85encode", _B("\x86\x4f\xd2\x6f\xb5\x59\xf7\x5b"))
    C("z85decode", "HelloWorld")
    C("z85decode", "Hello")
    C("z85decode", "Hel~o")
    C("z85decode", "%nSc0")
    C("z85decode", "%nSc1")
    return H


# ---------------------------------------------------------- generated cases

def _after_full_pad(s):
    """True if an alphabet character follows a '=' that completed a group
    (behaviour that changed between 3.13 patch releases; never tested in
    non-strict mode)."""
    alpha = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
    quad = pads = 0
    done = False
    for ch in s.encode("latin-1"):
        if ch == 61:
            if quad >= 2:
                pads += 1
                if quad + pads >= 4:
                    done = True
            continue
        if ch not in alpha:
            continue
        if done:
            return True
        pads = 0
        quad = (quad + 1) % 4
    return False


_B64CH = "ABCDYWJjaGVsbG8+/-_=\n !"


def _generated():
    rng = random.Random(15102026)
    out = []

    def rbytes(n):
        return {"$b": [rng.choice([0, 32, 255, rng.randint(0, 255)]) for _ in range(n)]}

    encs = [("b64encode", {}), ("urlsafe_b64encode", {}), ("b32encode", {}),
            ("b32hexencode", {}), ("b16encode", {}), ("a85encode", {"foldspaces": True}),
            ("a85encode", {"adobe": True, "wrapcol": 3}), ("a85encode", {"pad": True}),
            ("b85encode", {}), ("b85encode", {"pad": True}), ("z85encode", {}),
            ("encodebytes", {})]
    for fn, kw in encs:
        n = rng.randint(1, 13) if fn != "encodebytes" else rng.randint(50, 130)
        out.append({"op": "call", "fn": fn, "args": [rbytes(n)], "kwargs": kw})
    n_dec = 0
    while n_dec < 8:
        s = "".join(rng.choice(_B64CH) for _ in range(rng.randint(2, 12)))
        validate = rng.random() < 0.3
        if not validate and _after_full_pad(s):
            continue
        kw = {"validate": True} if validate else {}
        out.append({"op": "call", "fn": "b64decode", "args": [s], "kwargs": kw})
        n_dec += 1
    for _ in range(3):
        s = "".join(rng.choice("MFRGGZDA0189=mf") for _ in range(8))
        kw = {"casefold": True} if rng.random() < 0.5 else {}
        if rng.random() < 0.4:
            kw["map01"] = "L"
        out.append({"op": "call", "fn": "b32decode", "args": [s], "kwargs": kw})
    for _ in range(3):
        s = "".join(rng.choice("!!uuzyBO8 s~") for _ in range(rng.randint(1, 9)))
        out.append({"op": "call", "fn": "a85decode", "args": [s],
                    "kwargs": {"foldspaces": True} if rng.random() < 0.5 else {}})
    for _ in range(2):
        s = "".join(rng.choice("09AZaz|~#{}%") for _ in range(rng.randint(1, 9)))
        out.append({"op": "call", "fn": rng.choice(["b85decode", "z85decode"]),
                    "args": [s], "kwargs": {}})
    return out


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        c["id"] = "%s-%03d-%s" % (NAME, i, c["fn"])
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    if len(argv) != 2:
        print("usage: mod_b64.py <package_root>")
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
