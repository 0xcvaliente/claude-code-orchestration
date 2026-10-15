"""toolkit.b64: pure-Python Base16/32/64/85, Ascii85 and Z85 codecs
compatible with the standard library's `base64` for the subset in
spec/b64.md.

This is a stub.  Every public name exists so imports succeed; replace the
bodies.  Do not import base64, binascii or any other blocked module.
"""


class Error(ValueError):
    """Raised wherever base64 raises binascii.Error."""


def b64encode(s, altchars=None):
    raise NotImplementedError("toolkit.b64.b64encode")


def b64decode(s, altchars=None, validate=False):
    raise NotImplementedError("toolkit.b64.b64decode")


def standard_b64encode(s):
    raise NotImplementedError("toolkit.b64.standard_b64encode")


def standard_b64decode(s):
    raise NotImplementedError("toolkit.b64.standard_b64decode")


def urlsafe_b64encode(s):
    raise NotImplementedError("toolkit.b64.urlsafe_b64encode")


def urlsafe_b64decode(s):
    raise NotImplementedError("toolkit.b64.urlsafe_b64decode")


def encodebytes(s):
    raise NotImplementedError("toolkit.b64.encodebytes")


def decodebytes(s):
    raise NotImplementedError("toolkit.b64.decodebytes")


def b32encode(s):
    raise NotImplementedError("toolkit.b64.b32encode")


def b32decode(s, casefold=False, map01=None):
    raise NotImplementedError("toolkit.b64.b32decode")


def b32hexencode(s):
    raise NotImplementedError("toolkit.b64.b32hexencode")


def b32hexdecode(s, casefold=False):
    raise NotImplementedError("toolkit.b64.b32hexdecode")


def b16encode(s):
    raise NotImplementedError("toolkit.b64.b16encode")


def b16decode(s, casefold=False):
    raise NotImplementedError("toolkit.b64.b16decode")


def a85encode(b, *, foldspaces=False, wrapcol=0, pad=False, adobe=False):
    raise NotImplementedError("toolkit.b64.a85encode")


def a85decode(b, *, foldspaces=False, adobe=False, ignorechars=b' \t\n\r\v'):
    raise NotImplementedError("toolkit.b64.a85decode")


def b85encode(b, pad=False):
    raise NotImplementedError("toolkit.b64.b85encode")


def b85decode(b):
    raise NotImplementedError("toolkit.b64.b85decode")


def z85encode(s):
    raise NotImplementedError("toolkit.b64.z85encode")


def z85decode(s):
    raise NotImplementedError("toolkit.b64.z85decode")
