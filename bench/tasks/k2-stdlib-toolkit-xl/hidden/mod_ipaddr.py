"""Hidden differential cases for toolkit.ipaddr (graded against `ipaddress`).

Adapter interface: NAME, MODULE, ORACLES, WRAP, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_ipaddr.py <package_root>` runs the
self-test against <package_root>/toolkit/ipaddr.py.

cases() imports neither `ipaddress` nor the solution.  Constructor arguments
are JSON values: a str, an int, null, a float, {"bytes": hex} or
{"tuple": [a, b]}.  Objects used by the other operations are encoded as
["a", s] (ip_address(s)), ["n", s] (ip_network(s)), ["ns", s]
(ip_network(s, strict=False)) or ["v", value] (the raw value).
"""

import itertools
import json
import random
import sys
import time

NAME = "ipaddr"
MODULE = "toolkit.ipaddr"
ORACLES = ["ipaddress"]
WRAP = ["ipaddress.ip_address", "ipaddress.ip_network", "ipaddress.ip_interface",
        "ipaddress.IPv4Address", "ipaddress.IPv6Address", "ipaddress.IPv4Network",
        "ipaddress.IPv6Network", "ipaddress.IPv4Interface", "ipaddress.IPv6Interface",
        "ipaddress.summarize_address_range", "ipaddress.collapse_addresses",
        "ipaddress.get_mixed_type_key"]

_CLASSES = ("IPv4Address", "IPv6Address", "IPv4Network", "IPv6Network",
            "IPv4Interface", "IPv6Interface")
_FLAGS = ("is_private", "is_global", "is_multicast", "is_loopback", "is_link_local",
          "is_reserved", "is_unspecified")
_HOSTS = 6
_SUBNETS = 64


# ----------------------------------------------------------- normalization

def _norm(M, x):
    name = type(x).__name__
    if name in _CLASSES and isinstance(x, getattr(M, name)):
        return {"T": name, "s": str(x)}
    if x is NotImplemented:
        return {"NotImplemented": True}
    if isinstance(x, bool):
        return {"bool": x}
    if isinstance(x, int):
        return {"int": int(x)}
    if isinstance(x, str):
        return {"str": x}
    if isinstance(x, bytes):
        return {"bytes": x.hex()}
    if isinstance(x, (list, tuple)):
        return [_norm(M, v) for v in x]
    if x is None:
        return None
    return {"type": name}


def _err(e):
    return {"error": type(e).__name__}


def _arg(v):
    if isinstance(v, dict):
        if "bytes" in v:
            return bytes.fromhex(v["bytes"])
        if "tuple" in v:
            return tuple(v["tuple"])
    return v


def _obj(M, spec):
    kind, v = spec
    if kind == "a":
        return M.ip_address(_arg(v))
    if kind == "n":
        return M.ip_network(_arg(v))
    if kind == "ns":
        return M.ip_network(_arg(v), strict=False)
    if kind == "v":
        return _arg(v)
    raise ValueError(kind)


def _attrs(M, x, names):
    out = {}
    for n in names:
        try:
            if n == "hosts":
                v = list(itertools.islice(x.hosts(), _HOSTS))
            elif n == "int":
                v = int(x)
            elif n == "repr":
                v = repr(x)
            elif n == "str":
                v = str(x)
            else:
                v = getattr(x, n)
            out[n] = _norm(M, v)
        except Exception as e:  # noqa: BLE001
            out[n] = _err(e)
    return out


_ADDR = ("str", "repr", "exploded", "compressed", "packed", "int", "reverse_pointer",
         "version", "max_prefixlen") + _FLAGS
_ADDR6 = ("ipv4_mapped", "sixtofour", "teredo", "scope_id")
_NET = ("str", "network_address", "broadcast_address", "netmask", "hostmask", "prefixlen",
        "with_prefixlen", "with_netmask", "with_hostmask", "num_addresses", "version",
        "max_prefixlen", "exploded", "compressed", "hosts") + _FLAGS
_IFACE = ("str", "ip", "network", "netmask", "hostmask", "with_prefixlen", "with_netmask",
          "with_hostmask", "version", "exploded", "compressed")

_CMP = {
    "<": lambda a, b: a < b, "<=": lambda a, b: a <= b, ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b, "==": lambda a, b: a == b, "!=": lambda a, b: a != b,
}


def _sorted(M, xs):
    return sorted((_norm(M, x) for x in xs), key=lambda d: json.dumps(d, sort_keys=True))


def _dispatch(M, case):
    op = case["op"]
    if op == "addr":
        x = getattr(M, case.get("fn", "ip_address"))(_arg(case["arg"]))
        names = _ADDR + (_ADDR6 if x.version == 6 else ())
        return dict(_attrs(M, x, names), T=type(x).__name__)
    if op == "net":
        fn = getattr(M, case.get("fn", "ip_network"))
        x = fn(_arg(case["arg"])) if "strict" not in case else fn(_arg(case["arg"]), strict=case["strict"])
        return dict(_attrs(M, x, _NET), T=type(x).__name__)
    if op == "iface":
        x = getattr(M, case.get("fn", "ip_interface"))(_arg(case["arg"]))
        return dict(_attrs(M, x, _IFACE), T=type(x).__name__)
    if op == "arith":
        a, b = _obj(M, case["a"]), _obj(M, case["b"])
        return _norm(M, a + b if case["fn"] == "+" else a - b)
    if op == "cmp":
        return _norm(M, _CMP[case["fn"]](_obj(M, case["a"]), _obj(M, case["b"])))
    if op == "contains":
        return _norm(M, _obj(M, case["a"]) in _obj(M, case["net"]))
    if op == "rel":
        a, b = _obj(M, case["a"]), _obj(M, case["b"])
        return _norm(M, getattr(a, case["fn"])(b))
    if op == "subnets":
        net = _obj(M, case["net"])
        return _norm(M, list(itertools.islice(net.subnets(**case["kw"]), _SUBNETS)))
    if op == "supernet":
        return _norm(M, _obj(M, case["net"]).supernet(**case["kw"]))
    if op == "exclude":
        return _sorted(M, _obj(M, case["net"]).address_exclude(_obj(M, case["other"])))
    if op == "summarize":
        return _sorted(M, M.summarize_address_range(_obj(M, case["a"]), _obj(M, case["b"])))
    if op == "collapse":
        return _sorted(M, M.collapse_addresses([_obj(M, s) for s in case["items"]]))
    if op == "mixed_key":
        objs = [_obj(M, s) for s in case["items"]]
        return {"sorted": _norm(M, sorted(objs, key=M.get_mixed_type_key)),
                "key0": _norm(M, M.get_mixed_type_key(objs[0]))}
    raise ValueError(op)


def _run(M, case):
    if case["op"] == "multi":
        return [_run(M, item) for item in case["items"]]
    try:
        return _dispatch(M, case)
    except Exception as e:  # noqa: BLE001
        return _err(e)


def run_impl(mod, case):
    return _run(mod, case)


def run_oracle(case):
    import ipaddress
    return _run(ipaddress, case)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

def _chunks(seq, n):
    return [seq[i:i + n] for i in range(0, len(seq), n)]


def _hand():
    H = []

    def multi(items):
        H.append({"op": "multi", "items": items})

    def A(arg, fn="ip_address"):
        return {"op": "addr", "fn": fn, "arg": arg}

    def N(arg, fn="ip_network", strict=None):
        c = {"op": "net", "fn": fn, "arg": arg}
        if strict is not None:
            c["strict"] = strict
        return c

    def IF(arg, fn="ip_interface"):
        return {"op": "iface", "fn": fn, "arg": arg}

    pending = []

    def flush():
        for grp in _chunks(pending, 2):
            multi(grp)
        del pending[:]

    # IPv4 addresses, two per case (all attributes)
    for s in ["192.168.1.1", "0.0.0.0", "255.255.255.255", "127.0.0.1", "10.0.0.1",
              "172.16.5.4", "172.32.0.1", "100.64.0.1", "169.254.1.1", "224.0.0.1",
              "240.0.0.1", "192.0.0.9", "192.0.0.8", "192.0.0.171", "192.0.2.5",
              "198.18.0.1", "198.51.100.7", "203.0.113.9", "8.8.8.8", 3232235777,
              {"bytes": "c0a80101"}]:
        pending.append(A(s))
    pending.append(A(2 ** 32 - 1, "IPv4Address"))
    flush()
    # IPv4 parse errors
    bad4 = ["1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.256", "1.2.3.-1", "", "1.2.3.4/24",
            " 1.2.3.4", "1.2.3.a", "1234.1.1.1", "1..2.3", "0x1.2.3.4"]
    for grp in _chunks(bad4, 3):
        multi([A(s, "IPv4Address") for s in grp])
    multi([A(-1, "IPv4Address"), A(2 ** 32, "IPv4Address"), A({"bytes": "010203"}, "IPv4Address")])
    multi([A(None, "IPv4Address"), A(1.5, "IPv4Address"), A("1.2.3.4", "IPv6Address")])
    multi([A("1.2.3"), A(-1), A(None), A({"bytes": "0102030405"}), A(2 ** 128)])
    # IPv6 addresses
    for s in ["::", "::1", "2001:db8::1", "2001:DB8:0:0:1:0:0:1", "1:0:0:2:0:0:0:3",
              "fe80::1%eth0", "fe80::1%1", "::ffff:192.0.2.128", "::ffff:c000:280",
              "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:0.0.0.0", "::ffff:224.1.1.1",
              "::ffff:169.254.3.3", "2002:c000:0204::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
              "ff02::1", "fe80::", "fec0::1", "fc00::1", "64:ff9b::1.2.3.4", "100::1",
              "2001:1::1", "2001:2::", "2001:3::1", "2001:20::1", "3fff::1", "2001:4860::8888",
              "1:2:3:4:5:6:7:8", "1::", "::1.2.3.4", "0:0:0:0:0:ffff:1.2.3.4",
              "abcd:EF01::0db8", "0000:0000:0000:0000:0000:0000:0000:0001", "4000::1",
              "2001:db8:0:1:1:1:1:1", 2 ** 32, {"bytes": "20010db8000000000000000000000001"}]:
        pending.append(A(s))
    pending.append(A(2 ** 128 - 1, "IPv6Address"))
    flush()
    bad6 = [":::", "1:::2", "1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", ":1:2:3:4:5:6:7",
            "1:2:3:4:5:6:7:", "12345::", "g::1", "::1%", "::1%a%b", "1:2:3:4:5:6:7:8::",
            "::ffff:1.2.3.256", "::1.2.3", "1.2.3.4::", "fe80::1/64", "1:2:3:4:5:6:7::8",
            "::01.2.3.4", "1", "1:2"]
    for grp in _chunks(bad6, 4):
        multi([A(s, "IPv6Address") for s in grp])
    multi([A(-1, "IPv6Address"), A(2 ** 128, "IPv6Address"), A({"bytes": "0102"}, "IPv6Address"),
           A("1::2::3")])
    # networks
    for arg in ["192.168.0.0/24", "192.168.0.0/255.255.255.0", "192.168.0.0/0.0.0.255",
                "10.0.0.0/8", "0.0.0.0/0", "1.2.3.4/32", "1.2.3.4", "1.2.3.4/31",
                "10.0.0.0/30", "1.2.3.0/024", "0.0.0.0/0.0.0.0", "0.0.0.0/255.255.255.255",
                "100.64.0.0/10", "100.64.0.0/11", "192.0.0.0/24", "224.0.0.0/4",
                "127.0.0.0/8", "169.254.0.0/16", "240.0.0.0/4", "0.0.0.0/32", "8.0.0.0/8",
                "2001:db8::/32", "2001:db8::/64", "::/0", "::1/128", "fe80::/10", "ff00::/8",
                "::/128", "2001:db8::/127", "2001:db8::/126", "::ffff:192.0.2.0/120",
                "2001:4860::/32", 3232235520, 2 ** 32, {"bytes": "0a000001"},
                {"tuple": ["192.168.0.0", 24]}, {"tuple": [3232235520, "24"]},
                {"tuple": ["2001:db8::", 32]}]:
        pending.append(N(arg))
    pending.append(N("192.168.1.5/24", strict=False))
    pending.append(N({"tuple": ["192.168.0.1", "255.255.255.0"]}, strict=False))
    pending.append(N("2001:db8::1/64", strict=False))
    flush()
    multi([N("192.168.1.5/24"), N("2001:db8::1/64"), N("192.168.1.5/24", "IPv4Network")])
    multi([N(s, "IPv4Network") for s in ["1.2.3.0/33", "1.2.3.0/255.0.255.0", "1.2.3.0/-1",
                                         "1.2.3.0/", "1.2.3.0/24/1", "1.2.3.0/24 "]])
    multi([N(s) for s in ["1.2.3.0/33", "1.2.3.0/255.0.255.0", "1.2.3.0/24/1", "x/24"]])
    multi([N(s, "IPv6Network") for s in ["2001:db8::/129", "2001:db8::/ffff::", "1.2.3.0/24",
                                         "2001:db8::/+32"]])
    # interfaces
    for arg in ["192.168.1.5/24", "10.1.2.3/255.0.0.0", "10.1.2.3/0.255.255.255", "1.2.3.4",
                "2001:db8::5/64", "::1/128", 3232235777, {"tuple": ["10.0.0.9", 8]}]:
        pending.append(IF(arg))
    flush()
    multi([IF("1.2.3.4/33", "IPv4Interface"), IF("1.2.3.4/33"), IF("1.2.3.4/24/2"),
           IF("x/24"), IF("2001:db8::1/200", "IPv6Interface")])
    # arithmetic
    a = lambda s: ["a", s]  # noqa: E731
    v = lambda x: ["v", x]  # noqa: E731
    ar = [("+", a("1.2.3.4"), v(1)), ("-", a("1.2.3.4"), v(260)), ("+", a("255.255.255.255"), v(1)),
          ("-", a("0.0.0.0"), v(1)), ("+", a("::1"), v(2 ** 64)), ("+", a("::ffff:1.2.3.4"), v(1)),
          ("+", a("fe80::1%eth0"), v(1)), ("+", a("1.2.3.4"), v("1")), ("+", v(1), a("1.2.3.4")),
          ("-", a("1.2.3.4"), a("1.2.3.0")), ("+", a("1.2.3.4"), v(1.5)),
          ("-", a("ffff::"), v(-1))]
    for grp in _chunks(ar, 3):
        multi([{"op": "arith", "fn": f, "a": x, "b": y} for f, x, y in grp])
    # comparisons
    n = lambda s: ["n", s]  # noqa: E731
    pairs = [(a("1.2.3.4"), a("1.2.3.5")), (a("10.0.0.1"), a("10.0.0.1")),
             (a("1.2.3.4"), a("::1")), (a("1.2.3.4"), n("1.2.3.0/24")),
             (n("10.0.0.0/8"), n("10.0.0.0/16")), (n("10.0.0.0/8"), n("::/0")),
             (a("fe80::1%a"), a("fe80::1")), (a("fe80::1%a"), a("fe80::2")),
             (a("1.2.3.4"), v("1.2.3.4"))]
    for x, y in pairs:
        multi([{"op": "cmp", "fn": f, "a": x, "b": y} for f in ["<", "<=", ">", ">=", "==", "!="]])
    # containment
    multi([{"op": "contains", "a": x, "net": y} for x, y in [
        (a("192.168.1.255"), n("192.168.1.0/24")), (a("192.168.2.0"), n("192.168.1.0/24")),
        (a("::1"), n("0.0.0.0/0")), (n("192.168.1.0/25"), n("192.168.1.0/24")),
        (a("2001:db8::ff"), n("2001:db8::/120"))]])
    # relations
    rels = [("subnet_of", n("10.1.0.0/16"), n("10.0.0.0/8")), ("subnet_of", n("10.0.0.0/8"), n("10.1.0.0/16")),
            ("supernet_of", n("10.0.0.0/8"), n("10.1.0.0/16")), ("subnet_of", n("10.0.0.0/8"), n("10.0.0.0/8")),
            ("subnet_of", n("10.0.0.0/8"), n("::/0")), ("subnet_of", n("10.0.0.0/8"), a("10.0.0.1")),
            ("overlaps", n("10.0.0.0/8"), n("10.255.0.0/16")), ("overlaps", n("10.0.0.0/8"), n("11.0.0.0/8")),
            ("overlaps", n("10.0.0.0/8"), n("::/0")), ("compare_networks", n("10.0.0.0/8"), n("10.0.0.0/16")),
            ("compare_networks", n("10.0.0.0/16"), n("10.0.0.0/8")), ("compare_networks", n("10.0.0.0/8"), n("10.0.0.0/8")),
            ("compare_networks", n("10.0.1.0/24"), n("10.0.0.0/16")), ("compare_networks", n("10.0.0.0/8"), n("::/0")),
            ("supernet_of", n("2001:db8::/32"), n("2001:db8:1::/48"))]
    for grp in _chunks(rels, 3):
        multi([{"op": "rel", "fn": f, "a": x, "b": y} for f, x, y in grp])
    # subnets / supernet
    subs = [(n("192.168.0.0/24"), {}), (n("192.168.0.0/24"), {"prefixlen_diff": 2}),
            (n("192.168.0.0/24"), {"new_prefix": 27}), (n("192.168.0.0/24"), {"new_prefix": 23}),
            (n("192.168.0.0/24"), {"prefixlen_diff": 2, "new_prefix": 26}),
            (n("192.168.0.0/24"), {"prefixlen_diff": -1}), (n("192.168.0.0/24"), {"prefixlen_diff": 9}),
            (n("1.2.3.4/32"), {}), (n("192.168.0.0/24"), {"prefixlen_diff": 0}),
            (n("2001:db8::/64"), {"new_prefix": 66}), (n("::/0"), {"prefixlen_diff": 3}),
            (n("10.0.0.0/8"), {"new_prefix": 14})]
    for grp in _chunks(subs, 3):
        multi([{"op": "subnets", "net": x, "kw": kw} for x, kw in grp])
    sups = [(n("192.168.0.0/24"), {}), (n("192.168.0.0/24"), {"prefixlen_diff": 3}),
            (n("192.168.0.0/24"), {"new_prefix": 16}), (n("192.168.0.0/24"), {"new_prefix": 25}),
            (n("192.168.0.0/24"), {"prefixlen_diff": 2, "new_prefix": 20}),
            (n("192.168.0.0/24"), {"prefixlen_diff": 25}), (n("0.0.0.0/0"), {}),
            (n("2001:db8::/32"), {"new_prefix": 20}), (n("10.0.0.0/8"), {"prefixlen_diff": 0})]
    for grp in _chunks(sups, 3):
        multi([{"op": "supernet", "net": x, "kw": kw} for x, kw in grp])
    # address_exclude
    exc = [(n("192.0.2.0/28"), n("192.0.2.1/32")), (n("10.0.0.0/8"), n("10.0.0.0/8")),
           (n("10.0.0.0/8"), n("11.0.0.0/8")), (n("10.0.0.0/8"), n("::/0")),
           (n("10.0.0.0/8"), a("10.0.0.1")), (n("2001:db8::/32"), n("2001:db8:8000::/33")),
           (n("10.0.0.0/16"), n("10.0.77.0/24"))]
    for grp in _chunks(exc, 2):
        multi([{"op": "exclude", "net": x, "other": y} for x, y in grp])
    # summarize_address_range
    summ = [(a("192.0.2.0"), a("192.0.2.130")), (a("10.0.0.0"), a("10.0.0.0")),
            (a("10.0.0.5"), a("10.0.0.1")), (a("10.0.0.1"), a("::1")),
            (n("10.0.0.0/8"), a("10.0.0.1")), (a("0.0.0.0"), a("255.255.255.255")),
            (a("2001:db8::1"), a("2001:db8::ffff")), (a("255.255.255.254"), a("255.255.255.255")),
            (a("1.1.1.1"), v("1.1.1.9"))]
    for grp in _chunks(summ, 3):
        multi([{"op": "summarize", "a": x, "b": y} for x, y in grp])
    # collapse_addresses
    for items in [[n("192.0.2.0/25"), n("192.0.2.128/25")],
                  [n("10.0.0.0/24"), n("10.0.0.0/16"), n("10.1.0.0/16")],
                  [a("10.0.0.1"), a("10.0.0.2"), a("10.0.0.3"), a("10.0.0.0"), n("10.0.0.4/30")],
                  [a("1.2.3.4"), a("::1")], [n("1.0.0.0/8"), n("::/8")], [],
                  [n("2001:db8::/33"), n("2001:db8:8000::/33"), a("2001:db9::")],
                  [n("10.0.0.0/24"), n("10.0.0.0/24"), n("10.0.2.0/24"), n("1.2.3.4/32")]]:
        H.append({"op": "collapse", "items": items})
    # get_mixed_type_key
    H.append({"op": "mixed_key", "items": [n("10.0.0.0/8"), a("10.0.0.0"), n("10.0.0.0/16"),
                                           a("9.9.9.9"), n("9.0.0.0/8"), a("10.0.0.1")]})
    H.append({"op": "mixed_key", "items": [a("::1"), n("::/64"), a("::")]})
    H.append({"op": "mixed_key", "items": [v("x")]})
    return H


# ---------------------------------------------------------- generated cases

def _rand_v6_text(rng):
    groups = [0] * 8
    for i in range(8):
        if rng.random() < 0.5:
            groups[i] = rng.randint(0, 0xFFFF)
    if rng.random() < 0.2:
        groups[:6] = [0, 0, 0, 0, 0, 0xFFFF]
    texts = ["%x" % g for g in groups]
    style = rng.random()
    if style < 0.3:
        texts = ["%04x" % g for g in groups]
    elif style < 0.5:
        texts = [t.upper() for t in texts]
    s = ":".join(texts)
    if style >= 0.5:
        # compress one run of zero groups (not necessarily the longest)
        runs = [(i, j) for i in range(8) for j in range(i + 1, 9)
                if all(g == 0 for g in groups[i:j])]
        if runs:
            i, j = rng.choice(runs)
            s = ":".join(texts[:i]) + "::" + ":".join(texts[j:])
    return s


def _generated():
    rng = random.Random(17102026)
    out = []
    for _ in range(8):
        s = ".".join(str(rng.randint(0, 255)) for _ in range(4))
        out.append({"op": "addr", "fn": "ip_address", "arg": s})
    for _ in range(8):
        out.append({"op": "addr", "fn": "ip_address", "arg": _rand_v6_text(rng)})
    for _ in range(6):
        s = ".".join(str(rng.randint(0, 255)) for _ in range(4))
        out.append({"op": "net", "fn": "ip_network", "arg": "%s/%d" % (s, rng.randint(0, 32)),
                    "strict": False})
    for _ in range(3):
        out.append({"op": "net", "fn": "ip_network",
                    "arg": "%s/%d" % (_rand_v6_text(rng), rng.randint(0, 128)), "strict": False})
    for _ in range(4):
        base = rng.randint(0, 2 ** 32 - 5000)
        lo = ".".join(str(b) for b in base.to_bytes(4, "big"))
        hi_i = base + rng.randint(0, 4000)
        hi = ".".join(str(b) for b in hi_i.to_bytes(4, "big"))
        out.append({"op": "summarize", "a": ["a", lo], "b": ["a", hi]})
    for _ in range(3):
        items = []
        for _ in range(rng.randint(2, 7)):
            p = rng.randint(22, 32)
            x = (rng.randint(0, 255) << 2) << (32 - p) if p >= 22 else 0
            x &= (2 ** 32 - 1) ^ ((1 << (32 - p)) - 1)
            x |= 10 << 24
            items.append(["ns", "%s/%d" % (".".join(str(b) for b in x.to_bytes(4, "big")), p)])
        out.append({"op": "collapse", "items": items})
    return out


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        first = c["items"][0] if c["op"] == "multi" and c["items"] else c
        c["id"] = "%s-%03d-%s" % (NAME, i, first["op"])
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    if len(argv) != 2:
        print("usage: mod_ipaddr.py <package_root>")
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
