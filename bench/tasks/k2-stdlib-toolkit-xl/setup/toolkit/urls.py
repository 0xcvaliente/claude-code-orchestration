"""toolkit.urls: a pure-Python URL parsing and quoting module compatible with
the standard library's `urllib.parse` for the subset in spec/urls.md.

This is a stub.  Every public name exists so imports succeed; replace the
bodies.  Do not import urllib or any other blocked module.
"""


class SplitResult(tuple):
    """Named tuple (scheme, netloc, path, query, fragment) with username,
    password, hostname, port and geturl()."""

    def __new__(cls, *args, **kwargs):
        raise NotImplementedError("toolkit.urls.SplitResult")


class ParseResult(tuple):
    """Named tuple (scheme, netloc, path, params, query, fragment) with
    username, password, hostname, port and geturl()."""

    def __new__(cls, *args, **kwargs):
        raise NotImplementedError("toolkit.urls.ParseResult")


class DefragResult(tuple):
    """Named tuple (url, fragment) with geturl()."""

    def __new__(cls, *args, **kwargs):
        raise NotImplementedError("toolkit.urls.DefragResult")


def urlsplit(url, scheme='', allow_fragments=True):
    raise NotImplementedError("toolkit.urls.urlsplit")


def urlparse(url, scheme='', allow_fragments=True):
    raise NotImplementedError("toolkit.urls.urlparse")


def urlunsplit(components):
    raise NotImplementedError("toolkit.urls.urlunsplit")


def urlunparse(components):
    raise NotImplementedError("toolkit.urls.urlunparse")


def urljoin(base, url, allow_fragments=True):
    raise NotImplementedError("toolkit.urls.urljoin")


def urldefrag(url):
    raise NotImplementedError("toolkit.urls.urldefrag")


def quote(string, safe='/', encoding=None, errors=None):
    raise NotImplementedError("toolkit.urls.quote")


def quote_plus(string, safe='', encoding=None, errors=None):
    raise NotImplementedError("toolkit.urls.quote_plus")


def quote_from_bytes(bs, safe='/'):
    raise NotImplementedError("toolkit.urls.quote_from_bytes")


def unquote(string, encoding='utf-8', errors='replace'):
    raise NotImplementedError("toolkit.urls.unquote")


def unquote_plus(string, encoding='utf-8', errors='replace'):
    raise NotImplementedError("toolkit.urls.unquote_plus")


def unquote_to_bytes(string):
    raise NotImplementedError("toolkit.urls.unquote_to_bytes")


def urlencode(query, doseq=False, safe='', encoding=None, errors=None,
              quote_via=None):
    """quote_via defaults to quote_plus (None here only because the stub
    has no working quote_plus)."""
    raise NotImplementedError("toolkit.urls.urlencode")


def parse_qs(qs, keep_blank_values=False, strict_parsing=False,
             encoding='utf-8', errors='replace', max_num_fields=None, separator='&'):
    raise NotImplementedError("toolkit.urls.parse_qs")


def parse_qsl(qs, keep_blank_values=False, strict_parsing=False,
              encoding='utf-8', errors='replace', max_num_fields=None, separator='&'):
    raise NotImplementedError("toolkit.urls.parse_qsl")
