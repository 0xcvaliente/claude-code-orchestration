"""TOML 1.0 parser matching Python 3.13 tomllib. See spec/toml.md."""

__all__ = ["loads", "load", "TOMLDecodeError"]


class TOMLDecodeError(ValueError):
    """Raised wherever tomllib raises tomllib.TOMLDecodeError."""


def loads(s, /):
    """Parse a TOML document from a str and return a dict."""
    raise NotImplementedError


def load(fp, /):
    """Parse a TOML document from a binary file object and return a dict."""
    raise NotImplementedError
