# toolkit.ipaddr

A pure-Python IPv4/IPv6 address library in `toolkit/ipaddr.py` that behaves
like the Python 3.13 standard library module `ipaddress` for the subset
below. The hidden tests run the same call on `toolkit.ipaddr` and on
`ipaddress` and compare the results. The solution may not import
`ipaddress` (or any other module on the blocked list in SPEC.md).

## How results are compared

- An address, network or interface result is compared by its exact class
  name (`IPv4Address`, `IPv6Address`, `IPv4Network`, `IPv6Network`,
  `IPv4Interface`, `IPv6Interface`; it must be an instance of your
  module's class of that name) and its `str()`.
- `bool`, `int`, `str`, `bytes` and `None` results must have that type
  and value; lists and tuples are compared element by element.
- The results of `address_exclude`, `summarize_address_range` and
  `collapse_addresses` are compared as multisets (order is ignored).
  Every other sequence is compared in order.
- `hosts()` is compared on its first 6 elements and `subnets()` on its
  first 64 (both must be iterables; they may be lazy).
- Exceptions: only the class name is compared, never the message. The
  kinds are `AddressValueError`, `NetmaskValueError` (both subclasses of
  `ValueError`, defined in your module), `ValueError` and `TypeError`.
  Where this spec says `ValueError` the exception must be exactly
  `ValueError`, not a subclass.
- A test that reads many attributes of one object reports each attribute
  separately; an attribute that raises only spoils itself, but the test
  passes only when all of them match.

## Public names

`ip_address`, `ip_network`, `ip_interface`, `IPv4Address`, `IPv6Address`,
`IPv4Network`, `IPv6Network`, `IPv4Interface`, `IPv6Interface`,
`AddressValueError`, `NetmaskValueError`, `summarize_address_range`,
`collapse_addresses`, `get_mixed_type_key`.

## Parsing addresses

`IPv4Address(x)` / `IPv6Address(x)` accept:

- an `int` in `0 .. 2**32-1` (IPv4) or `0 .. 2**128-1` (IPv6); outside the
  range raises `AddressValueError`;
- `bytes` of length exactly 4 (IPv4) or 16 (IPv6), big-endian; another
  length raises `AddressValueError`;
- anything else is converted with `str()` and parsed as text (so `None`
  and `1.5` raise `AddressValueError`). Text containing `/` raises
  `AddressValueError`.

IPv4 text: exactly four decimal octets separated by `.`; each octet is 1
to 3 ASCII digits with value <= 255 and no leading zero (`"0"` is fine,
`"01"` is not). No whitespace, signs, hex or empty octets. Any violation
raises `AddressValueError`.

IPv6 text, all violations raising `AddressValueError`:

- An optional zone id: everything after the first `%`. It must be
  non-empty and contain no further `%` (`"::1%"`, `"::1%a%b"` are
  invalid). The zone id is kept as the `scope_id` attribute.
- The address part is split on `:`. Each group is 1 to 4 hex digits
  (either case). The last group may instead be an IPv4 address in the
  text form above (it stands for two groups): `"::ffff:1.2.3.4"`,
  `"1:2:3:4:5:6:1.2.3.4"`.
- At most one `::`, which stands for one or more zero groups. Without
  `::` there must be exactly 8 groups. With it, at most 7 explicit
  groups. A leading or trailing single `:` is invalid (`":1:2:3:4:5:6:7"`,
  `"1:2:3:4:5:6:7:"`). At least two colons are required (`"1"`, `"1:2"`
  are invalid).

`ip_address(x)` tries `IPv4Address(x)` then `IPv6Address(x)` and returns
the first that succeeds (so an int below `2**32` is IPv4); if both raise
`AddressValueError` it raises `ValueError`.

## Address attributes

For both versions:

- `str(a)` / `compressed`: IPv4 dotted decimal. IPv6: lowercase groups
  without leading zeros; the longest run of two or more zero groups is
  replaced by `::` (the first such run on a tie; a single zero group is
  written `0`), e.g. `"2001:DB8:0:0:1:0:0:1"` gives `"2001:db8::1:0:0:1"`.
  An IPv4-mapped address (see `ipv4_mapped`) is written
  `"::ffff:" + str(ipv4_mapped)`. Other addresses are never written with
  a dotted tail (`"::1.2.3.4"` gives `"::102:304"`). A zone id is appended
  as `"%zone"`.
- `repr(a)`: `"IPv4Address('...')"` / `"IPv6Address('...')"` around `str(a)`.
- `exploded`: IPv4 same as `str`. IPv6: eight 4-digit lowercase hex
  groups, plus `"%zone"` if there is a zone id; for an IPv4-mapped address
  the last two groups are replaced by the dotted IPv4 address
  (`"0000:0000:0000:0000:0000:ffff:192.0.2.128"`).
- `packed`: the big-endian `bytes` (4 or 16). `int(a)`: the integer value.
- `reverse_pointer`: IPv4 `"d.c.b.a.in-addr.arpa"`. IPv6: take `exploded`,
  remove the `:` characters, reverse the string and join its characters
  with `.`, then append `".ip6.arpa"` (a zone id is therefore included,
  reversed). For an IPv4-mapped address use the 32 hex digits of the full
  address instead of `exploded`.
- `version` (4 or 6), `max_prefixlen` (32 or 128).

IPv6 only:

- `ipv4_mapped`: the `IPv4Address` of the low 32 bits if the high 96 bits
  are `0:0:0:0:0:ffff`, else `None`.
- `sixtofour`: if the first group is `2002`, the `IPv4Address` of bits
  80..111 (groups 2 and 3), else `None`.
- `teredo`: if the first two groups are `2001:0000`, the tuple
  `(server, client)` where server is the `IPv4Address` of groups 3-4 and
  client the `IPv4Address` of the bitwise complement of the low 32 bits;
  else `None`.
- `scope_id`: the zone id string, or `None`.

### Address flags

IPv4 address:

- `is_private`: in one of `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`,
  `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.0.170/31`,
  `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`,
  `203.0.113.0/24`, `240.0.0.0/4`, `255.255.255.255/32`, and not
  `192.0.0.9` or `192.0.0.10`.
- `is_global`: not in `100.64.0.0/10` and not `is_private` (so
  `100.64.0.0/10` is neither private nor global).
- `is_multicast`: in `224.0.0.0/4`. `is_loopback`: in `127.0.0.0/8`.
  `is_link_local`: in `169.254.0.0/16`. `is_reserved`: in `240.0.0.0/4`.
  `is_unspecified`: equal to `0.0.0.0`.

IPv6 address that is IPv4-mapped: every flag is the flag of
`ipv4_mapped`. Other IPv6 addresses:

- `is_private`: in one of `::1/128`, `::/128`, `::ffff:0:0/96`,
  `64:ff9b:1::/48`, `100::/64`, `2001::/23`, `2001:db8::/32`,
  `2002::/16`, `3fff::/20`, `fc00::/7`, `fe80::/10`, and not in any of
  `2001:1::1/128`, `2001:1::2/128`, `2001:3::/32`, `2001:4:112::/48`,
  `2001:20::/28`, `2001:30::/28`.
- `is_global`: not `is_private`.
- `is_multicast`: in `ff00::/8`. `is_link_local`: in `fe80::/10`.
  `is_loopback`: equal to `::1`. `is_unspecified`: equal to `::`.
- `is_reserved`: in one of `::/8`, `100::/8`, `200::/7`, `400::/6`,
  `800::/5`, `1000::/4`, `4000::/3`, `6000::/3`, `8000::/3`, `a000::/3`,
  `c000::/3`, `e000::/4`, `f000::/5`, `f800::/6`, `fe00::/9`.

## Networks

`IPv4Network(x, strict=True)` / `IPv6Network(x, strict=True)` accept:

- an `int` or `bytes` (as for addresses) with the full prefix length;
- a tuple `(address, prefix)` where address is anything the address
  class accepts and prefix is an `int` or a prefix/mask string;
- text `"address"` or `"address/mask"`. More than one `/` raises
  `AddressValueError`. The address part is parsed as above (errors are
  `AddressValueError`, checked before the mask). No mask means the full
  prefix length.

Masks (invalid ones raise `NetmaskValueError`):

- a prefix length: ASCII decimal digits only (no sign, no spaces; leading
  zeros allowed, `"024"` is 24) with value 0..32 (IPv4) or 0..128 (IPv6);
- IPv4 only: a dotted netmask (ones then zeros, e.g. `255.255.255.0`) or
  a dotted hostmask (zeros then ones, e.g. `0.0.0.255`); `0.0.0.0` means
  /0 and `255.255.255.255` /32. IPv6 accepts only prefix lengths.

If the address has bits set outside the mask: with `strict=True` raise
`ValueError`; with `strict=False` clear them.

`ip_network(x, strict=True)` tries `IPv4Network` then `IPv6Network`;
when both raise `AddressValueError` or `NetmaskValueError` it raises
`ValueError`. The host-bits `ValueError` propagates directly.

Attributes: `network_address`, `broadcast_address` (last address),
`netmask`, `hostmask` (all addresses of the same version), `prefixlen`,
`num_addresses`, `version`, `max_prefixlen`; `str(n)` / `compressed` =
`str(network_address) + "/" + prefixlen`; `with_prefixlen` (same as
`str`), `with_netmask` (`"addr/netmask"`), `with_hostmask`
(`"addr/hostmask"`); `exploded`: IPv4 same as `str`, IPv6 the network
address as eight 4-digit groups (never dotted, even if IPv4-mapped) plus
`"/prefixlen"`.

`hosts()`: the usable addresses in order: all addresses except the
network address and the broadcast address for IPv4; all except the
network address for IPv6 (the last address is included). Special cases:
a /31 (IPv4) or /127 (IPv6) network yields every address, and a /32 or
/128 network yields its single address.

Network flags: `is_multicast`, `is_reserved`, `is_link_local`,
`is_unspecified` and `is_loopback` are true iff both `network_address`
and `broadcast_address` have that address flag (address flags as above,
including the IPv4-mapped rule). `is_private`: some network in that
version's private list contains both the network and broadcast
addresses (plain integer containment, no IPv4-mapped rule), and neither
of them lies in an exception network. `is_global`: IPv4: not (both
endpoints in `100.64.0.0/10`) and not `is_private`; IPv6: not
`is_private`.

Methods:

- `subnets(prefixlen_diff=1, new_prefix=None)`: if the prefix is already
  the maximum, yields just the network itself (arguments ignored).
  Otherwise, if `new_prefix` is given: `ValueError` when it is shorter
  than the current prefix or when `prefixlen_diff` is not 1; else
  `prefixlen_diff = new_prefix - prefixlen`. `ValueError` when
  `prefixlen_diff < 0` or the new prefix exceeds the maximum. Yields the
  subnets of the new prefix in ascending order (`prefixlen_diff=0`
  yields the network itself).
- `supernet(prefixlen_diff=1, new_prefix=None)`: a /0 network returns
  itself. `new_prefix` longer than the current prefix, or `new_prefix`
  together with `prefixlen_diff != 1`, raises `ValueError`; a resulting
  prefix below 0 raises `ValueError`. Returns the containing network.
- `subnet_of(other)`, `supernet_of(other)`: bool; `TypeError` if `other`
  has a different version or is not a network.
- `overlaps(other)`: bool, true iff either network contains an endpoint
  of the other; networks of different versions give `False`.
- `compare_networks(other)`: -1, 0 or 1 comparing network addresses,
  then netmasks; `TypeError` for different versions.
- `address_exclude(other)`: the networks covering `self` minus `other`
  (each half not containing `other`, repeatedly split, as `ipaddress`
  does); empty when equal. `TypeError` when the versions differ or
  `other` is not a network; `ValueError` when `other` is not a subnet of
  `self`.
- `addr in net`: bool; `False` for an address of the other version and
  for any network on the left.

## Interfaces

`IPv4Interface(x)` / `IPv6Interface(x)` take the same inputs as the
network classes but never reject host bits. `ip_interface(x)` tries
IPv4 then IPv6 and raises `ValueError` when both fail with
`AddressValueError`/`NetmaskValueError`. Attributes: `str(i)` /
`compressed` = `"address/prefixlen"`; `ip` (the address), `network` (the
network with host bits cleared), `netmask`, `hostmask`, `with_prefixlen`
(`"address/prefixlen"`), `with_netmask` (`"address/netmask"`),
`with_hostmask` (`"address/hostmask"`), `version`, and `exploded`
(address exploded as above plus `"/prefixlen"`).

## Arithmetic and comparison

- `addr + n`, `addr - n` with an `int` `n`: a new address of the same
  class (no zone id); a result outside the range raises
  `AddressValueError`. Any non-`int` operand (`str`, `float`, another
  address), or `int + addr`, raises `TypeError`.
- Addresses of the same version order by integer value. `==` needs the
  same version, value and (IPv6) zone id, so `fe80::1%a != fe80::1`.
  `<=`, `>` and `>=` follow from `<` and `==` as with
  `functools.total_ordering` (`a > b` is `not a < b and a != b`), so
  `fe80::1%a > fe80::1` is `True`.
- Networks of the same version order by network address, then netmask.
- Ordering between different versions, between an address and a network,
  or with a non-IP object raises `TypeError`; `==` in those cases is
  `False` and `!=` is `True`.

## Module functions

- `summarize_address_range(first, last)`: the minimal list of networks
  exactly covering `first..last` inclusive. `TypeError` if either argument
  is not an address (a network or a string) or the versions differ;
  `ValueError` if `first > last`.
- `collapse_addresses(iterable)`: the minimal list of networks covering
  all given addresses and networks (an address, or a network with the
  full prefix, counts as a single address). `TypeError` when two
  addresses (or two networks) have different versions. An empty input
  gives an empty result.
- `get_mixed_type_key(obj)`: `(version, network_address, netmask)` for a
  network, `(version, address)` for an address, and `NotImplemented` for
  anything else. Tests sort lists of addresses and networks with it and
  compare the sorted list and the key of the first item.

## Never tested

`format()` of addresses, `hash()`, pickling, `__iter__`/`__getitem__` of
networks, `is_site_local`, `ipv6_mapped`, `v4_int_to_packed`,
`v6_int_to_packed`, interface comparisons and interface flags, networks
or interfaces with a zone id, IPv4-mapped interfaces, IPv4-mapped
addresses with a zone id, non-ASCII text, `bool` arguments, `overlaps`
or `in` with an address argument on the right of `overlaps`, collapsing
a mix of addresses of one version with networks of the other, and
inputs longer than 45 characters (before the zone id).
