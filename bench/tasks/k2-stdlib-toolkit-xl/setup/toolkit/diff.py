"""toolkit.diff: a pure-Python sequence differ compatible with the standard
library's `difflib` module for the subset in spec/diff.md.

This is a stub.  Every public name exists so imports succeed; replace the
bodies.  Do not import difflib, re or any other blocked module.
"""

from collections import namedtuple

Match = namedtuple("Match", "a b size")


class SequenceMatcher:
    def __init__(self, isjunk=None, a="", b="", autojunk=True):
        raise NotImplementedError("toolkit.diff.SequenceMatcher")

    def set_seqs(self, a, b):
        raise NotImplementedError

    def set_seq1(self, a):
        raise NotImplementedError

    def set_seq2(self, b):
        raise NotImplementedError

    def find_longest_match(self, alo=0, ahi=None, blo=0, bhi=None):
        raise NotImplementedError

    def get_matching_blocks(self):
        raise NotImplementedError

    def get_opcodes(self):
        raise NotImplementedError

    def get_grouped_opcodes(self, n=3):
        raise NotImplementedError

    def ratio(self):
        raise NotImplementedError

    def quick_ratio(self):
        raise NotImplementedError

    def real_quick_ratio(self):
        raise NotImplementedError


def get_close_matches(word, possibilities, n=3, cutoff=0.6):
    raise NotImplementedError("toolkit.diff.get_close_matches")


def IS_LINE_JUNK(line):
    raise NotImplementedError("toolkit.diff.IS_LINE_JUNK")


def IS_CHARACTER_JUNK(ch, ws=" \t"):
    raise NotImplementedError("toolkit.diff.IS_CHARACTER_JUNK")


def ndiff(a, b, linejunk=None, charjunk=IS_CHARACTER_JUNK):
    raise NotImplementedError("toolkit.diff.ndiff")


def restore(delta, which):
    raise NotImplementedError("toolkit.diff.restore")


def unified_diff(a, b, fromfile="", tofile="", fromfiledate="", tofiledate="",
                 n=3, lineterm="\n"):
    raise NotImplementedError("toolkit.diff.unified_diff")


def context_diff(a, b, fromfile="", tofile="", fromfiledate="", tofiledate="",
                 n=3, lineterm="\n"):
    raise NotImplementedError("toolkit.diff.context_diff")
