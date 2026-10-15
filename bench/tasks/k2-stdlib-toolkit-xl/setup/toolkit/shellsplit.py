"""Shell-like splitting and quoting matching Python 3.13 shlex. See spec/shlex.md."""

__all__ = ["split", "quote", "join"]


def split(s, comments=False, posix=True):
    """Split s like shlex.split(s, comments, posix)."""
    raise NotImplementedError


def quote(s):
    """Return a shell-escaped version of s, like shlex.quote(s)."""
    raise NotImplementedError


def join(split_command):
    """Join a list of strings into a shell-escaped command line, like shlex.join(split_command)."""
    raise NotImplementedError
