"""toolkit.regex: a pure-Python regular expression engine compatible with the
standard library's `re` module for the subset in spec/regex.md.

This is a stub.  Every public name exists so imports succeed; replace the
bodies.  Do not import re, sre_*, _sre or any other blocked module.
"""

NOFLAG = 0
I = IGNORECASE = 2
M = MULTILINE = 8
S = DOTALL = 16


class error(Exception):
    """Raised wherever `re` raises re.error (re.PatternError)."""

    def __init__(self, msg, pattern=None, pos=None):
        self.msg = msg
        self.pattern = pattern
        self.pos = pos
        super().__init__(msg)


PatternError = error


class Pattern:
    """Compiled pattern: attributes pattern, flags, groups, groupindex."""

    def __init__(self, pattern, flags=0):
        raise NotImplementedError("toolkit.regex.Pattern")

    def match(self, string, pos=0, endpos=None):
        raise NotImplementedError

    def fullmatch(self, string, pos=0, endpos=None):
        raise NotImplementedError

    def search(self, string, pos=0, endpos=None):
        raise NotImplementedError

    def findall(self, string, pos=0, endpos=None):
        raise NotImplementedError

    def finditer(self, string, pos=0, endpos=None):
        raise NotImplementedError

    def sub(self, repl, string, count=0):
        raise NotImplementedError

    def subn(self, repl, string, count=0):
        raise NotImplementedError

    def split(self, string, maxsplit=0):
        raise NotImplementedError


class Match:
    """Match object: group, groups, groupdict, start, end, span, expand, and
    attributes string, re, pos, endpos, lastindex, lastgroup."""

    def group(self, *args):
        raise NotImplementedError

    def groups(self, default=None):
        raise NotImplementedError

    def groupdict(self, default=None):
        raise NotImplementedError

    def start(self, group=0):
        raise NotImplementedError

    def end(self, group=0):
        raise NotImplementedError

    def span(self, group=0):
        raise NotImplementedError

    def expand(self, template):
        raise NotImplementedError


def compile(pattern, flags=0):
    raise NotImplementedError("toolkit.regex.compile")


def match(pattern, string, flags=0):
    raise NotImplementedError("toolkit.regex.match")


def fullmatch(pattern, string, flags=0):
    raise NotImplementedError("toolkit.regex.fullmatch")


def search(pattern, string, flags=0):
    raise NotImplementedError("toolkit.regex.search")


def findall(pattern, string, flags=0):
    raise NotImplementedError("toolkit.regex.findall")


def finditer(pattern, string, flags=0):
    raise NotImplementedError("toolkit.regex.finditer")


def sub(pattern, repl, string, count=0, flags=0):
    raise NotImplementedError("toolkit.regex.sub")


def subn(pattern, repl, string, count=0, flags=0):
    raise NotImplementedError("toolkit.regex.subn")


def split(pattern, string, maxsplit=0, flags=0):
    raise NotImplementedError("toolkit.regex.split")


def escape(pattern):
    raise NotImplementedError("toolkit.regex.escape")
