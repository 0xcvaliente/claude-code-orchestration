"""toolkit.jsonx: a pure-Python JSON encoder and decoder compatible with the
standard library's `json` module for the subset in spec/jsonx.md.

This is a stub.  Every public name exists so imports succeed; replace the
bodies.  Do not import json, _json or any other blocked module.
"""


class JSONDecodeError(ValueError):
    """Raised by loads wherever json raises json.JSONDecodeError.

    Attributes: msg, doc, pos, lineno, colno (see the spec)."""

    def __init__(self, msg, doc, pos):
        ValueError.__init__(self, msg)
        self.msg = msg
        self.doc = doc
        self.pos = pos
        self.lineno = None
        self.colno = None


def dumps(obj, *, skipkeys=False, ensure_ascii=True, check_circular=True,
          allow_nan=True, indent=None, separators=None, default=None,
          sort_keys=False):
    """Serialize obj to a JSON formatted str."""
    raise NotImplementedError("toolkit.jsonx.dumps")


def loads(s, *, object_hook=None, parse_float=None, parse_int=None,
          parse_constant=None, object_pairs_hook=None, strict=True):
    """Deserialize the str s containing a JSON document to a Python object."""
    raise NotImplementedError("toolkit.jsonx.loads")
