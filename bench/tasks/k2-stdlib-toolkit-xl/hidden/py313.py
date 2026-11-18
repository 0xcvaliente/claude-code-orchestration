r"""Recorded oracle results that grade.py uses, on Python 3.14 or later, in place of the live oracle for eight cases.

task.md grades against Python 3.13's standard library. grade.py re-runs itself under python3.13 when it finds
one; when it runs under 3.14 or later instead, `expected` returns the value recorded below for a listed case.
What each recorded value is, and what is established about it (no CPython 3.13 was available when this was
last checked, on 2026-11-18, so none of the values was reproduced on 3.13 then):
- fraction-098-format: ValueError for the three precision formats with a leading zero (`.05f`). CPython 3.14.4
  formats the third one (`-1234.56700`), CPython 3.12.16 raises ValueError for all four inputs.
- ipaddr-020-addr, ipaddr-021-addr: the scoped address keeps its scope in `exploded` and `reverse_pointer`.
  CPython 3.14.4 and CPython 3.12.16 both give AddressValueError there instead; an earlier review measured
  it on 3.13.5 and 3.14.4 and found that 3.13.5 also gives the 3.14 result. So the recorded value is not
  what every 3.13 release gives.
- jsonx-106-loads: an unterminated string reported at pos 0 (the string's start). CPython 3.14.4 and CPython
  3.12.16 both report pos 2; an earlier review measured it on 3.13.5 and 3.14.4 and found that 3.13.5 also
  gives the 3.14 result (pos 2).
- regex-025-search, regex-188-fullmatch: no match (None). CPython 3.12.16 gives no match; CPython 3.14.4
  matches the empty string (`\B` on an empty string).
- urls-140-urljoin, urls-142-urljoin: `http:///h/` and `https:///k;p/g/h`. CPython 3.12.16 gives these values;
  CPython 3.14.4 gives `http:/h/` and `https:/k;p/g/h`.
Not listed, so graded by the live oracle on any version: wrap-100-fill, wrap-102-wrap and wrap-123-wrap,
whose results an earlier review measured on 3.13.5 and 3.14.4 and found to differ between 3.13 patch
releases; CPython 3.12.16 and CPython 3.14.4 also give different results for all three.
"""
import sys

PY313 = {
 "fraction-098-format": [
  {
   "error": "ValueError"
  },
  {
   "error": "ValueError"
  },
  {
   "error": "ValueError"
  },
  {
   "str": "-1234567/1000"
  }
 ],
 "ipaddr-020-addr": [
  {
   "T": "IPv6Address",
   "compressed": {
    "str": "1:0:0:2::3"
   },
   "exploded": {
    "str": "0001:0000:0000:0002:0000:0000:0000:0003"
   },
   "int": {
    "int": 5192296858534864522018643748323331
   },
   "ipv4_mapped": None,
   "is_global": {
    "bool": True
   },
   "is_link_local": {
    "bool": False
   },
   "is_loopback": {
    "bool": False
   },
   "is_multicast": {
    "bool": False
   },
   "is_private": {
    "bool": False
   },
   "is_reserved": {
    "bool": True
   },
   "is_unspecified": {
    "bool": False
   },
   "max_prefixlen": {
    "int": 128
   },
   "packed": {
    "bytes": "00010000000000020000000000000003"
   },
   "repr": {
    "str": "IPv6Address('1:0:0:2::3')"
   },
   "reverse_pointer": {
    "str": "3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.ip6.arpa"
   },
   "scope_id": None,
   "sixtofour": None,
   "str": {
    "str": "1:0:0:2::3"
   },
   "teredo": None,
   "version": {
    "int": 6
   }
  },
  {
   "T": "IPv6Address",
   "compressed": {
    "str": "fe80::1%eth0"
   },
   "exploded": {
    "str": "fe80:0000:0000:0000:0000:0000:0000:0001%eth0"
   },
   "int": {
    "int": 338288524927261089654018896841347694593
   },
   "ipv4_mapped": None,
   "is_global": {
    "bool": False
   },
   "is_link_local": {
    "bool": True
   },
   "is_loopback": {
    "bool": False
   },
   "is_multicast": {
    "bool": False
   },
   "is_private": {
    "bool": True
   },
   "is_reserved": {
    "bool": False
   },
   "is_unspecified": {
    "bool": False
   },
   "max_prefixlen": {
    "int": 128
   },
   "packed": {
    "bytes": "fe800000000000000000000000000001"
   },
   "repr": {
    "str": "IPv6Address('fe80::1%eth0')"
   },
   "reverse_pointer": {
    "str": "0.h.t.e.%.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.e.f.ip6.arpa"
   },
   "scope_id": {
    "str": "eth0"
   },
   "sixtofour": None,
   "str": {
    "str": "fe80::1%eth0"
   },
   "teredo": None,
   "version": {
    "int": 6
   }
  }
 ],
 "ipaddr-021-addr": [
  {
   "T": "IPv6Address",
   "compressed": {
    "str": "fe80::1%1"
   },
   "exploded": {
    "str": "fe80:0000:0000:0000:0000:0000:0000:0001%1"
   },
   "int": {
    "int": 338288524927261089654018896841347694593
   },
   "ipv4_mapped": None,
   "is_global": {
    "bool": False
   },
   "is_link_local": {
    "bool": True
   },
   "is_loopback": {
    "bool": False
   },
   "is_multicast": {
    "bool": False
   },
   "is_private": {
    "bool": True
   },
   "is_reserved": {
    "bool": False
   },
   "is_unspecified": {
    "bool": False
   },
   "max_prefixlen": {
    "int": 128
   },
   "packed": {
    "bytes": "fe800000000000000000000000000001"
   },
   "repr": {
    "str": "IPv6Address('fe80::1%1')"
   },
   "reverse_pointer": {
    "str": "1.%.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.e.f.ip6.arpa"
   },
   "scope_id": {
    "str": "1"
   },
   "sixtofour": None,
   "str": {
    "str": "fe80::1%1"
   },
   "teredo": None,
   "version": {
    "int": 6
   }
  },
  {
   "T": "IPv6Address",
   "compressed": {
    "str": "::ffff:192.0.2.128"
   },
   "exploded": {
    "str": "0000:0000:0000:0000:0000:ffff:192.0.2.128"
   },
   "int": {
    "int": 281473902969472
   },
   "ipv4_mapped": {
    "T": "IPv4Address",
    "s": "192.0.2.128"
   },
   "is_global": {
    "bool": False
   },
   "is_link_local": {
    "bool": False
   },
   "is_loopback": {
    "bool": False
   },
   "is_multicast": {
    "bool": False
   },
   "is_private": {
    "bool": True
   },
   "is_reserved": {
    "bool": False
   },
   "is_unspecified": {
    "bool": False
   },
   "max_prefixlen": {
    "int": 128
   },
   "packed": {
    "bytes": "00000000000000000000ffffc0000280"
   },
   "repr": {
    "str": "IPv6Address('::ffff:192.0.2.128')"
   },
   "reverse_pointer": {
    "str": "0.8.2.0.0.0.0.c.f.f.f.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa"
   },
   "scope_id": None,
   "sixtofour": None,
   "str": {
    "str": "::ffff:192.0.2.128"
   },
   "teredo": None,
   "version": {
    "int": 6
   }
  }
 ],
 "jsonx-106-loads": {
  "colno": 1,
  "error": "JSONDecodeError",
  "lineno": 1,
  "pos": 0
 },
 "regex-025-search": None,
 "regex-188-fullmatch": None,
 "urls-140-urljoin": {
  "type": "str",
  "value": "http:///h/"
 },
 "urls-142-urljoin": {
  "type": "str",
  "value": "https:///k;p/g/h"
 }
}


def expected(case_id, result):
    """The oracle result to grade against: the 3.13 one for a listed case on Python 3.14 or later."""
    if sys.version_info >= (3, 14) and case_id in PY313:
        return PY313[case_id]
    return result
