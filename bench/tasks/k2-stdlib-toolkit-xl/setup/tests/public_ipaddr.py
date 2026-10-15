"""Public examples for toolkit.ipaddr, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_ipaddr.py
"""

import itertools
import os
import sys

EXAMPLES = [
    {"name": "v4-basics", "expr": lambda M: [str(M.ip_address("172.20.1.9")),
                                             M.ip_address("172.20.1.9").is_private,
                                             M.ip_address("172.20.1.9").reverse_pointer,
                                             int(M.ip_address("172.20.1.9"))]},
    {"name": "v6-compress", "expr": lambda M: [str(M.ip_address("2001:0db8:0000:0000:0000:ff00:0042:8329")),
                                               M.ip_address("2001:db8::ff00:42:8329").exploded]},
    {"name": "v6-mapped", "expr": lambda M: [str(M.IPv6Address("::ffff:7f00:1")),
                                             M.IPv6Address("::ffff:7f00:1").is_loopback,
                                             M.IPv6Address("::ffff:7f00:1").ipv4_mapped]},
    {"name": "network", "expr": lambda M: [M.ip_network("172.16.32.0/20").broadcast_address,
                                           M.ip_network("172.16.32.0/20").with_netmask,
                                           list(itertools.islice(M.ip_network("172.16.32.0/20").hosts(), 3)),
                                           M.ip_network("172.16.32.0/20").num_addresses]},
    {"name": "network-strict", "expr": lambda M: M.ip_network("172.16.33.0/20")},
    {"name": "subnets", "expr": lambda M: list(M.ip_network("10.10.0.0/22").subnets(new_prefix=24))},
    {"name": "interface", "expr": lambda M: [M.ip_interface("10.9.8.7/12").network,
                                             M.ip_interface("10.9.8.7/12").with_hostmask]},
    {"name": "summarize", "expr": lambda M: sorted(str(n) for n in M.summarize_address_range(
        M.ip_address("10.0.0.3"), M.ip_address("10.0.0.20")))},
    {"name": "bad-octet", "expr": lambda M: M.IPv4Address("10.0.0.300")},
]


def _norm(x):
    name = type(x).__name__
    if name.startswith("IPv") and name[-7:] in ("Address", "Network") or name.endswith("Interface"):
        return (name, str(x))
    if isinstance(x, (list, tuple)):
        return [_norm(v) for v in x]
    return (name, x)


def _run(M, ex):
    try:
        return _norm(ex["expr"](M))
    except Exception as e:  # noqa: BLE001
        return ("error", type(e).__name__)


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.ipaddr as mod
    import ipaddress
    got = _run(mod, ex)
    want = _run(ipaddress, ex)
    return got == want, "got %r, want %r" % (got, want)


if __name__ == "__main__":
    ok = 0
    for ex in EXAMPLES:
        try:
            r, detail = check(ex)
        except Exception as e:  # noqa: BLE001
            r, detail = False, repr(e)
        print("PASS" if r else "FAIL", ex["name"], "" if r else detail)
        ok += bool(r)
    print("ipaddr public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
