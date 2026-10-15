"""toolkit.wrap: a pure-Python text wrapper compatible with the standard
library's `textwrap` module for the subset in spec/wrap.md.

This is a stub.  Every public name exists so imports succeed; replace the
bodies.  Do not import textwrap, re, string or any other blocked module.
"""


class TextWrapper:
    def __init__(self, width=70, initial_indent="", subsequent_indent="",
                 expand_tabs=True, replace_whitespace=True,
                 fix_sentence_endings=False, break_long_words=True,
                 drop_whitespace=True, break_on_hyphens=True, tabsize=8,
                 *, max_lines=None, placeholder=" [...]"):
        raise NotImplementedError("toolkit.wrap.TextWrapper")

    def wrap(self, text):
        raise NotImplementedError

    def fill(self, text):
        raise NotImplementedError


def wrap(text, width=70, **kwargs):
    raise NotImplementedError("toolkit.wrap.wrap")


def fill(text, width=70, **kwargs):
    raise NotImplementedError("toolkit.wrap.fill")


def shorten(text, width, **kwargs):
    raise NotImplementedError("toolkit.wrap.shorten")


def dedent(text):
    raise NotImplementedError("toolkit.wrap.dedent")


def indent(text, prefix, predicate=None):
    raise NotImplementedError("toolkit.wrap.indent")
