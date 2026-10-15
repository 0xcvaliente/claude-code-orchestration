"""toolkit.ipaddr: a pure-Python IPv4/IPv6 library compatible with the
standard library's `ipaddress` module for the subset in spec/ipaddr.md.

This is a stub.  The public names exist so imports succeed; replace the
bodies.  Do not import ipaddress or any other blocked module.
"""


class AddressValueError(ValueError):
    """A value error related to the address."""


class NetmaskValueError(ValueError):
    """A value error related to the netmask."""


def ip_address(address):
    raise NotImplementedError("toolkit.ipaddr.ip_address")


def ip_network(address, strict=True):
    raise NotImplementedError("toolkit.ipaddr.ip_network")


def ip_interface(address):
    raise NotImplementedError("toolkit.ipaddr.ip_interface")


def summarize_address_range(first, last):
    raise NotImplementedError("toolkit.ipaddr.summarize_address_range")


def collapse_addresses(addresses):
    raise NotImplementedError("toolkit.ipaddr.collapse_addresses")


def get_mixed_type_key(obj):
    raise NotImplementedError("toolkit.ipaddr.get_mixed_type_key")


class IPv4Address:
    def __init__(self, address):
        raise NotImplementedError("toolkit.ipaddr.IPv4Address")


class IPv6Address:
    def __init__(self, address):
        raise NotImplementedError("toolkit.ipaddr.IPv6Address")


class IPv4Network:
    def __init__(self, address, strict=True):
        raise NotImplementedError("toolkit.ipaddr.IPv4Network")


class IPv6Network:
    def __init__(self, address, strict=True):
        raise NotImplementedError("toolkit.ipaddr.IPv6Network")


class IPv4Interface(IPv4Address):
    def __init__(self, address):
        raise NotImplementedError("toolkit.ipaddr.IPv4Interface")


class IPv6Interface(IPv6Address):
    def __init__(self, address):
        raise NotImplementedError("toolkit.ipaddr.IPv6Interface")
