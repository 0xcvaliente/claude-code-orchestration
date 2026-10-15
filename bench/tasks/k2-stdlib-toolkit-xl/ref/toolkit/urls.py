"""toolkit.urls: reference implementation of the urllib.parse subset in
spec/urls.md.  Pure Python, no urllib, re or ipaddress."""

from collections import namedtuple

__all__ = ["urlparse", "urlunparse", "urljoin", "urldefrag", "urlsplit",
           "urlunsplit", "urlencode", "parse_qs", "parse_qsl", "quote",
           "quote_plus", "quote_from_bytes", "unquote", "unquote_plus",
           "unquote_to_bytes", "SplitResult", "ParseResult", "DefragResult"]

uses_relative = ['', 'ftp', 'http', 'gopher', 'nntp', 'imap',
                 'wais', 'file', 'https', 'shttp', 'mms',
                 'prospero', 'rtsp', 'rtsps', 'rtspu', 'sftp',
                 'svn', 'svn+ssh', 'ws', 'wss']

uses_netloc = ['', 'ftp', 'http', 'gopher', 'nntp', 'telnet',
               'imap', 'wais', 'file', 'mms', 'https', 'shttp',
               'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync',
               'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh',
               'ws', 'wss', 'itms-services']

uses_params = ['', 'ftp', 'hdl', 'prospero', 'http', 'imap',
               'https', 'shttp', 'rtsp', 'rtsps', 'rtspu', 'sip',
               'sips', 'mms', 'sftp', 'tel']

_SCHEME_CHARS = ('abcdefghijklmnopqrstuvwxyz'
                 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
                 '0123456789+-.')
_C0_OR_SPACE = ''.join(chr(i) for i in range(0x21))
_HEX = '0123456789abcdefABCDEF'


# ------------------------------------------------------------ result types

class _NetlocMixin:
    __slots__ = ()

    @property
    def _userinfo(self):
        userinfo, have_info, _ = self.netloc.rpartition('@')
        if have_info:
            username, have_password, password = userinfo.partition(':')
            if not have_password:
                password = None
        else:
            username = password = None
        return username, password

    @property
    def _hostinfo(self):
        _, _, hostinfo = self.netloc.rpartition('@')
        _, have_open_br, bracketed = hostinfo.partition('[')
        if have_open_br:
            hostname, _, port = bracketed.partition(']')
            _, _, port = port.partition(':')
        else:
            hostname, _, port = hostinfo.partition(':')
        if not port:
            port = None
        return hostname, port

    @property
    def username(self):
        return self._userinfo[0]

    @property
    def password(self):
        return self._userinfo[1]

    @property
    def hostname(self):
        hostname = self._hostinfo[0]
        if not hostname:
            return None
        hostname, percent, zone = hostname.partition('%')
        return hostname.lower() + percent + zone

    @property
    def port(self):
        port = self._hostinfo[1]
        if port is not None:
            if port.isdigit() and port.isascii():
                port = int(port)
            else:
                raise ValueError("Port could not be cast to integer value as %r" % (port,))
            if not (0 <= port <= 65535):
                raise ValueError("Port out of range 0-65535")
        return port


class SplitResult(namedtuple('SplitResult', 'scheme netloc path query fragment'),
                  _NetlocMixin):
    __slots__ = ()

    def geturl(self):
        return urlunsplit(self)


class ParseResult(namedtuple('ParseResult', 'scheme netloc path params query fragment'),
                  _NetlocMixin):
    __slots__ = ()

    def geturl(self):
        return urlunparse(self)


class DefragResult(namedtuple('DefragResult', 'url fragment')):
    __slots__ = ()

    def geturl(self):
        if self.fragment:
            return self.url + '#' + self.fragment
        return self.url


# ----------------------------------------------------------------- parsing

def _is_ipv4(s):
    parts = s.split('.')
    if len(parts) != 4:
        return False
    for p in parts:
        if not p or len(p) > 3 or not (p.isascii() and p.isdigit()):
            return False
        if len(p) > 1 and p[0] == '0':
            return False
        if int(p) > 255:
            return False
    return True


def _is_ipv6(s):
    if '%' in s:
        s, _, scope = s.partition('%')
        if not scope or '%' in scope:
            return False
    if not s:
        return False
    parts = s.split(':')
    if len(parts) < 3:
        return False
    if '.' in parts[-1]:
        if not _is_ipv4(parts.pop()):
            return False
        parts.append('0')
        parts.append('0')
    if len(parts) > 9:
        return False
    skip = None
    for i in range(1, len(parts) - 1):
        if not parts[i]:
            if skip is not None:
                return False
            skip = i
    if skip is not None:
        hi = skip
        lo = len(parts) - skip - 1
        if not parts[0]:
            hi -= 1
            if hi:
                return False
        if not parts[-1]:
            lo -= 1
            if lo:
                return False
        if 8 - (hi + lo) < 1:
            return False
        check = parts[:hi] + (parts[len(parts) - lo:] if lo else [])
    else:
        if len(parts) != 8 or not parts[0] or not parts[-1]:
            return False
        check = parts
    for p in check:
        if not p or len(p) > 4 or any(c not in _HEX for c in p):
            return False
    return True


def _check_bracketed_host(hostname):
    if hostname.startswith(('v', 'V')):
        i = 1
        while i < len(hostname) and hostname[i] in _HEX:
            i += 1
        ok = (i > 1 and i < len(hostname) and hostname[i] == '.'
              and i + 1 < len(hostname) and '\n' not in hostname[i + 1:])
        if not ok:
            raise ValueError("IPvFuture address is invalid")
    else:
        if _is_ipv4(hostname):
            raise ValueError("An IPv4 address cannot be in brackets")
        if not _is_ipv6(hostname):
            raise ValueError("%r does not appear to be an IPv4 or IPv6 address" % hostname)


def _check_bracketed_netloc(netloc):
    hostport = netloc.rpartition('@')[2]
    before, have_open_br, bracketed = hostport.partition('[')
    if have_open_br:
        if before:
            raise ValueError("Invalid IPv6 URL")
        hostname, _, port = bracketed.partition(']')
        if port and not port.startswith(':'):
            raise ValueError("Invalid IPv6 URL")
    else:
        hostname, _, port = hostport.partition(':')
    _check_bracketed_host(hostname)


def _splitnetloc(url, start=0):
    delim = len(url)
    for c in '/?#':
        w = url.find(c, start)
        if w >= 0:
            delim = min(delim, w)
    return url[start:delim], url[delim:]


def urlsplit(url, scheme='', allow_fragments=True):
    url = url.lstrip(_C0_OR_SPACE)
    scheme = scheme.strip(_C0_OR_SPACE)
    for b in '\t\r\n':
        url = url.replace(b, '')
        scheme = scheme.replace(b, '')
    netloc = query = fragment = ''
    i = url.find(':')
    if i > 0 and url[0].isascii() and url[0].isalpha():
        for c in url[:i]:
            if c not in _SCHEME_CHARS:
                break
        else:
            scheme, url = url[:i].lower(), url[i + 1:]
    if url[:2] == '//':
        netloc, url = _splitnetloc(url, 2)
        if (('[' in netloc and ']' not in netloc) or
                (']' in netloc and '[' not in netloc)):
            raise ValueError("Invalid IPv6 URL")
        if '[' in netloc and ']' in netloc:
            _check_bracketed_netloc(netloc)
    if allow_fragments and '#' in url:
        url, fragment = url.split('#', 1)
    if '?' in url:
        url, query = url.split('?', 1)
    return SplitResult(scheme, netloc, url, query, fragment)


def _splitparams(url):
    if '/' in url:
        i = url.find(';', url.rfind('/'))
        if i < 0:
            return url, ''
    else:
        i = url.find(';')
    return url[:i], url[i + 1:]


def urlparse(url, scheme='', allow_fragments=True):
    scheme, netloc, url, query, fragment = urlsplit(url, scheme, allow_fragments)
    if scheme in uses_params and ';' in url:
        url, params = _splitparams(url)
    else:
        params = ''
    return ParseResult(scheme, netloc, url, params, query, fragment)


def urlunsplit(components):
    scheme, netloc, url, query, fragment = components
    if netloc:
        if url and url[:1] != '/':
            url = '/' + url
        url = '//' + netloc + url
    elif url[:2] == '//':
        url = '//' + url
    elif scheme and scheme in uses_netloc and (not url or url[:1] == '/'):
        url = '//' + url
    if scheme:
        url = scheme + ':' + url
    if query:
        url = url + '?' + query
    if fragment:
        url = url + '#' + fragment
    return url


def urlunparse(components):
    scheme, netloc, url, params, query, fragment = components
    if params:
        url = "%s;%s" % (url, params)
    return urlunsplit((scheme, netloc, url, query, fragment))


def urljoin(base, url, allow_fragments=True):
    if not base:
        return url
    if not url:
        return base
    bscheme, bnetloc, bpath, bparams, bquery, bfragment = urlparse(base, '', allow_fragments)
    scheme, netloc, path, params, query, fragment = urlparse(url, bscheme, allow_fragments)
    if scheme != bscheme or scheme not in uses_relative:
        return url
    if scheme in uses_netloc:
        if netloc:
            return urlunparse((scheme, netloc, path, params, query, fragment))
        netloc = bnetloc
    if not path and not params:
        path = bpath
        params = bparams
        if not query:
            query = bquery
        return urlunparse((scheme, netloc, path, params, query, fragment))
    base_parts = bpath.split('/')
    if base_parts[-1] != '':
        del base_parts[-1]
    if path[:1] == '/':
        segments = path.split('/')
    else:
        segments = base_parts + path.split('/')
        segments[1:-1] = [s for s in segments[1:-1] if s]
    resolved = []
    for seg in segments:
        if seg == '..':
            if resolved:
                resolved.pop()
        elif seg == '.':
            continue
        else:
            resolved.append(seg)
    if segments[-1] in ('.', '..'):
        resolved.append('')
    return urlunparse((scheme, netloc, '/'.join(resolved) or '/', params, query, fragment))


def urldefrag(url):
    if '#' in url:
        s, n, p, a, q, frag = urlparse(url)
        defrag = urlunparse((s, n, p, a, q, ''))
    else:
        frag = ''
        defrag = url
    return DefragResult(defrag, frag)


# ----------------------------------------------------------------- quoting

_ALWAYS_SAFE = frozenset(b'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
                         b'abcdefghijklmnopqrstuvwxyz'
                         b'0123456789_.-~')


def quote_from_bytes(bs, safe='/'):
    if not isinstance(bs, (bytes, bytearray)):
        raise TypeError("quote_from_bytes() expected bytes")
    if not bs:
        return ''
    if isinstance(safe, str):
        safe = safe.encode('ascii', 'ignore')
    else:
        safe = bytes([c for c in safe if c < 128])
    ok = _ALWAYS_SAFE.union(safe)
    return ''.join(chr(b) if b in ok else '%%%02X' % b for b in bs)


def quote(string, safe='/', encoding=None, errors=None):
    if isinstance(string, str):
        if not string:
            return string
        if encoding is None:
            encoding = 'utf-8'
        if errors is None:
            errors = 'strict'
        string = string.encode(encoding, errors)
    else:
        if encoding is not None:
            raise TypeError("quote() doesn't support 'encoding' for bytes")
        if errors is not None:
            raise TypeError("quote() doesn't support 'errors' for bytes")
    return quote_from_bytes(string, safe)


def quote_plus(string, safe='', encoding=None, errors=None):
    if ((isinstance(string, str) and ' ' not in string) or
            (isinstance(string, bytes) and b' ' not in string)):
        return quote(string, safe, encoding, errors)
    space = ' ' if isinstance(safe, str) else b' '
    return quote(string, safe + space, encoding, errors).replace(' ', '+')


def _unquote_impl(string):
    if not string:
        string.split
        return b''
    if isinstance(string, str):
        string = string.encode('utf-8')
    bits = string.split(b'%')
    if len(bits) == 1:
        return bytes(string)
    res = bytearray(bits[0])
    for item in bits[1:]:
        h = item[:2]
        if len(h) == 2 and all(c in b'0123456789abcdefABCDEF' for c in h):
            res.append(int(h, 16))
            res.extend(item[2:])
        else:
            res.extend(b'%')
            res.extend(item)
    return bytes(res)


def unquote_to_bytes(string):
    return bytes(_unquote_impl(string))


def unquote(string, encoding='utf-8', errors='replace'):
    if isinstance(string, bytes):
        return _unquote_impl(string).decode(encoding, errors)
    if '%' not in string:
        string.split
        return string
    if encoding is None:
        encoding = 'utf-8'
    if errors is None:
        errors = 'replace'
    out = []
    i = 0
    n = len(string)
    while i < n:
        j = i
        if string[i] < '\x80':
            while j < n and string[j] < '\x80':
                j += 1
            out.append(_unquote_impl(string[i:j]).decode(encoding, errors))
        else:
            while j < n and string[j] >= '\x80':
                j += 1
            out.append(string[i:j])
        i = j
    return ''.join(out)


def unquote_plus(string, encoding='utf-8', errors='replace'):
    string = string.replace('+', ' ')
    return unquote(string, encoding, errors)


# ------------------------------------------------------------ query strings

def parse_qsl(qs, keep_blank_values=False, strict_parsing=False,
              encoding='utf-8', errors='replace', max_num_fields=None, separator='&'):
    if not separator or not isinstance(separator, (str, bytes)):
        raise ValueError("Separator must be of type string or bytes.")
    if isinstance(qs, str):
        if not isinstance(separator, str):
            separator = str(separator, 'ascii')
        eq = '='

        def _unq(s):
            return unquote_plus(s, encoding=encoding, errors=errors)
    else:
        if not qs:
            return []
        qs = bytes(memoryview(qs))
        if isinstance(separator, str):
            separator = bytes(separator, 'ascii')
        eq = b'='

        def _unq(s):
            return unquote_to_bytes(s.replace(b'+', b' '))
    if not qs:
        return []
    if max_num_fields is not None:
        if max_num_fields < 1 + qs.count(separator):
            raise ValueError('Max number of fields exceeded')
    r = []
    for name_value in qs.split(separator):
        if name_value or strict_parsing:
            name, has_eq, value = name_value.partition(eq)
            if not has_eq and strict_parsing:
                raise ValueError("bad query field: %r" % (name_value,))
            if value or keep_blank_values:
                r.append((_unq(name), _unq(value)))
    return r


def parse_qs(qs, keep_blank_values=False, strict_parsing=False,
             encoding='utf-8', errors='replace', max_num_fields=None, separator='&'):
    out = {}
    for name, value in parse_qsl(qs, keep_blank_values, strict_parsing,
                                 encoding=encoding, errors=errors,
                                 max_num_fields=max_num_fields, separator=separator):
        out.setdefault(name, []).append(value)
    return out


def urlencode(query, doseq=False, safe='', encoding=None, errors=None,
              quote_via=quote_plus):
    if hasattr(query, "items"):
        query = query.items()
    else:
        try:
            if len(query) and not isinstance(query[0], tuple):
                raise TypeError
        except TypeError as err:
            raise TypeError("not a valid non-string sequence "
                            "or mapping object") from err

    def q(x):
        if isinstance(x, bytes):
            return quote_via(x, safe)
        return quote_via(str(x), safe, encoding, errors)

    out = []
    for k, v in query:
        k = q(k)
        if not doseq or isinstance(v, (bytes, str)):
            out.append(k + '=' + q(v))
            continue
        try:
            len(v)
        except TypeError:
            out.append(k + '=' + q(v))
        else:
            for elt in v:
                out.append(k + '=' + q(elt))
    return '&'.join(out)
