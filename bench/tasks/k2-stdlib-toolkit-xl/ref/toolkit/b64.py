"""toolkit.b64: reference implementation of the base64 subset in
spec/b64.md.  Pure Python, no base64, binascii, struct or re."""

__all__ = ["Error", "b64encode", "b64decode", "standard_b64encode",
           "standard_b64decode", "urlsafe_b64encode", "urlsafe_b64decode",
           "b32encode", "b32decode", "b32hexencode", "b32hexdecode",
           "b16encode", "b16decode", "a85encode", "a85decode", "b85encode",
           "b85decode", "z85encode", "z85decode", "encodebytes", "decodebytes"]


class Error(ValueError):
    """Raised wherever base64 raises binascii.Error."""


def _bytes_from_decode_data(s):
    if isinstance(s, str):
        try:
            return s.encode('ascii')
        except UnicodeEncodeError:
            raise ValueError('string argument should contain only ASCII characters')
    if isinstance(s, (bytes, bytearray)):
        return bytes(s)
    try:
        return memoryview(s).tobytes()
    except TypeError:
        raise TypeError("argument should be a bytes-like object or ASCII "
                        "string, not %r" % s.__class__.__name__) from None


def _binary(s):
    """Bytes-like input only (what binascii accepts for encoding)."""
    if isinstance(s, str):
        raise TypeError("a bytes-like object is required, not 'str'")
    if isinstance(s, (bytes, bytearray)):
        return bytes(s)
    return memoryview(s).tobytes()


# ----------------------------------------------------------------- base64

_B64 = b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
_B64REV = {c: i for i, c in enumerate(_B64)}


def _b2a(data):
    out = bytearray()
    n = len(data)
    for i in range(0, n - n % 3, 3):
        v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
        out += bytes((_B64[v >> 18], _B64[(v >> 12) & 63],
                      _B64[(v >> 6) & 63], _B64[v & 63]))
    rest = n % 3
    if rest == 1:
        v = data[-1] << 16
        out += bytes((_B64[v >> 18], _B64[(v >> 12) & 63])) + b'=='
    elif rest == 2:
        v = (data[-2] << 16) | (data[-1] << 8)
        out += bytes((_B64[v >> 18], _B64[(v >> 12) & 63], _B64[(v >> 6) & 63])) + b'='
    return bytes(out)


def _a2b(data, strict=False):
    if strict and data[:1] == b'=':
        raise Error("Leading padding not allowed")
    out = bytearray()
    quad = 0
    left = 0
    pads = 0
    padding_started = False
    n = len(data)
    for i in range(n):
        ch = data[i]
        if ch == 61:  # '='
            padding_started = True
            if strict and quad == 0:
                raise Error("Excess padding not allowed")
            if quad >= 2:
                pads += 1
                if quad + pads >= 4 and strict and i + 1 < n:
                    raise Error("Excess data after padding")
            continue
        v = _B64REV.get(ch)
        if v is None:
            if strict:
                raise Error("Only base64 data is allowed")
            continue
        if strict and padding_started:
            raise Error("Discontinuous padding not allowed")
        pads = 0
        if quad == 0:
            quad = 1
            left = v
        elif quad == 1:
            quad = 2
            out.append(((left << 2) | (v >> 4)) & 0xFF)
            left = v & 0x0F
        elif quad == 2:
            quad = 3
            out.append(((left << 4) | (v >> 2)) & 0xFF)
            left = v & 0x03
        else:
            quad = 0
            out.append(((left << 6) | v) & 0xFF)
            left = 0
    if quad == 1:
        raise Error("Invalid base64-encoded string: number of data characters "
                    "cannot be 1 more than a multiple of 4")
    if quad != 0 and quad + pads < 4:
        raise Error("Incorrect padding")
    return bytes(out)


def _translate(s, frm, to):
    return s.translate(bytes.maketrans(frm, to))


def b64encode(s, altchars=None):
    encoded = _b2a(_binary(s))
    if altchars is not None:
        return _translate(encoded, b'+/', altchars)
    return encoded


def b64decode(s, altchars=None, validate=False):
    s = _bytes_from_decode_data(s)
    if altchars is not None:
        altchars = _bytes_from_decode_data(altchars)
        s = _translate(s, altchars, b'+/')
    return _a2b(s, strict=validate)


def standard_b64encode(s):
    return b64encode(s)


def standard_b64decode(s):
    return b64decode(s)


def urlsafe_b64encode(s):
    return _translate(b64encode(s), b'+/', b'-_')


def urlsafe_b64decode(s):
    s = _bytes_from_decode_data(s)
    return b64decode(_translate(s, b'-_', b'+/'))


def encodebytes(s):
    s = _input_type_check(s)
    return b''.join(_b2a(s[i:i + 57]) + b'\n' for i in range(0, len(s), 57))


def decodebytes(s):
    return _a2b(_input_type_check(s))


def _input_type_check(s):
    try:
        m = memoryview(s)
    except TypeError as err:
        raise TypeError("expected bytes-like object, not %s" % s.__class__.__name__) from err
    if m.format not in ('c', 'b', 'B'):
        raise TypeError("expected single byte elements")
    if m.ndim != 1:
        raise TypeError("expected 1-D data")
    return m.tobytes()


# ----------------------------------------------------------------- base32

_B32 = b'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
_B32HEX = b'0123456789ABCDEFGHIJKLMNOPQRSTUV'


def _b32encode(alphabet, s):
    s = _binary(s) if not isinstance(s, (bytes, bytearray)) else bytes(s)
    leftover = len(s) % 5
    if leftover:
        s = s + b'\0' * (5 - leftover)
    out = bytearray()
    for i in range(0, len(s), 5):
        c = int.from_bytes(s[i:i + 5], 'big')
        for shift in range(35, -1, -5):
            out.append(alphabet[(c >> shift) & 31])
    pad = {1: 6, 2: 4, 3: 3, 4: 1}.get(leftover, 0)
    if pad:
        out[-pad:] = b'=' * pad
    return bytes(out)


def _b32decode(alphabet, s, casefold=False, map01=None):
    rev = {v: k for k, v in enumerate(alphabet)}
    s = _bytes_from_decode_data(s)
    if len(s) % 8:
        raise Error('Incorrect padding')
    if map01 is not None:
        map01 = _bytes_from_decode_data(map01)
        s = _translate(s, b'01', b'O' + map01)
    if casefold:
        s = s.upper()
    l = len(s)
    s = s.rstrip(b'=')
    padchars = l - len(s)
    decoded = bytearray()
    acc = 0
    for i in range(0, len(s), 8):
        acc = 0
        for c in s[i:i + 8]:
            if c not in rev:
                raise Error('Non-base32 digit found')
            acc = (acc << 5) + rev[c]
        decoded += acc.to_bytes(5, 'big')
    if l % 8 or padchars not in {0, 1, 3, 4, 6}:
        raise Error('Incorrect padding')
    if padchars and decoded:
        acc <<= 5 * padchars
        last = acc.to_bytes(5, 'big')
        leftover = (43 - 5 * padchars) // 8
        decoded[-5:] = last[:leftover]
    return bytes(decoded)


def b32encode(s):
    return _b32encode(_B32, s)


def b32decode(s, casefold=False, map01=None):
    return _b32decode(_B32, s, casefold, map01)


def b32hexencode(s):
    return _b32encode(_B32HEX, s)


def b32hexdecode(s, casefold=False):
    return _b32decode(_B32HEX, s, casefold)


# ----------------------------------------------------------------- base16

def b16encode(s):
    return _binary(s).hex().upper().encode('ascii')


def b16decode(s, casefold=False):
    s = _bytes_from_decode_data(s)
    if casefold:
        s = s.upper()
    for c in s:
        if c not in b'0123456789ABCDEF':
            raise Error('Non-base16 digit found')
    if len(s) % 2:
        raise Error('Odd-length string')
    return bytes.fromhex(s.decode('ascii'))


# ------------------------------------------------------- ascii85 / base85

def _85encode(b, chars, pad=False, foldnuls=False, foldspaces=False):
    if not isinstance(b, (bytes, bytearray)):
        b = _binary(b)
    b = bytes(b)
    padding = (-len(b)) % 4
    if padding:
        b = b + b'\0' * padding
    chunks = []
    for i in range(0, len(b), 4):
        word = int.from_bytes(b[i:i + 4], 'big')
        if foldnuls and not word:
            chunks.append(b'z')
        elif foldspaces and word == 0x20202020:
            chunks.append(b'y')
        else:
            digs = []
            for _ in range(5):
                digs.append(chars[word % 85])
                word //= 85
            chunks.append(bytes(reversed(digs)))
    if padding and not pad:
        if chunks[-1] == b'z':
            chunks[-1] = bytes([chars[0]]) * 5
        chunks[-1] = chunks[-1][:-padding]
    return b''.join(chunks)


_A85 = bytes(range(33, 118))


def a85encode(b, *, foldspaces=False, wrapcol=0, pad=False, adobe=False):
    result = _85encode(b, _A85, pad, True, foldspaces)
    if adobe:
        result = b'<~' + result
    if wrapcol:
        wrapcol = max(2 if adobe else 1, wrapcol)
        chunks = [result[i:i + wrapcol] for i in range(0, len(result), wrapcol)]
        if adobe:
            if len(chunks[-1]) + 2 > wrapcol:
                chunks.append(b'')
        result = b'\n'.join(chunks)
    if adobe:
        result += b'~>'
    return result


def a85decode(b, *, foldspaces=False, adobe=False, ignorechars=b' \t\n\r\v'):
    b = _bytes_from_decode_data(b)
    if adobe:
        if not b.endswith(b'~>'):
            raise ValueError("Ascii85 encoded byte sequences must end with b'~>'")
        if b.startswith(b'<~'):
            b = b[2:-2]
        else:
            b = b[:-2]
    decoded = []
    curr = []
    for x in b + b'u' * 4:
        if 33 <= x <= 117:
            curr.append(x)
            if len(curr) == 5:
                acc = 0
                for c in curr:
                    acc = 85 * acc + (c - 33)
                if acc > 0xFFFFFFFF:
                    raise ValueError('Ascii85 overflow')
                decoded.append(acc.to_bytes(4, 'big'))
                curr.clear()
        elif x == 122:  # 'z'
            if curr:
                raise ValueError('z inside Ascii85 5-tuple')
            decoded.append(b'\0\0\0\0')
        elif foldspaces and x == 121:  # 'y'
            if curr:
                raise ValueError('y inside Ascii85 5-tuple')
            decoded.append(b'    ')
        elif x in ignorechars:
            continue
        else:
            raise ValueError('Non-Ascii85 digit found: %c' % x)
    result = b''.join(decoded)
    padding = 4 - len(curr)
    if padding:
        result = result[:-padding]
    return result


_B85 = (b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        b"abcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~")
_B85REV = {c: i for i, c in enumerate(_B85)}


def b85encode(b, pad=False):
    return _85encode(b, _B85, pad)


def b85decode(b):
    b = _bytes_from_decode_data(b)
    padding = (-len(b)) % 5
    b = b + b'~' * padding
    out = []
    for i in range(0, len(b), 5):
        acc = 0
        for j, c in enumerate(b[i:i + 5]):
            v = _B85REV.get(c)
            if v is None:
                raise ValueError('bad base85 character at position %d' % (i + j))
            acc = acc * 85 + v
        if acc > 0xFFFFFFFF:
            raise ValueError('base85 overflow in hunk starting at byte %d' % i)
        out.append(acc.to_bytes(4, 'big'))
    result = b''.join(out)
    if padding:
        result = result[:-padding]
    return result


_Z85 = (b'0123456789abcdefghijklmnopqrstuvwxyz'
        b'ABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#')
_Z85_DEC = bytes.maketrans(_Z85 + b';_`|~', _B85 + b'\x00' * 5)
_Z85_ENC = bytes.maketrans(_B85, _Z85)


def z85encode(s):
    return b85encode(s).translate(_Z85_ENC)


def z85decode(s):
    s = _bytes_from_decode_data(s).translate(_Z85_DEC)
    try:
        return b85decode(s)
    except ValueError as e:
        raise ValueError(e.args[0].replace('base85', 'z85')) from None
