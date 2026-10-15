"""toolkit.diff: reference implementation of the difflib subset in spec/diff.md.

Pure Python; imports no blocked module (no difflib, no re).
"""

from collections import namedtuple

__all__ = ["SequenceMatcher", "Match", "get_close_matches", "ndiff", "restore",
           "unified_diff", "context_diff", "IS_LINE_JUNK", "IS_CHARACTER_JUNK"]

Match = namedtuple("Match", "a b size")


def _ratio(matches, length):
    return 2.0 * matches / length if length else 1.0


class SequenceMatcher:
    def __init__(self, isjunk=None, a="", b="", autojunk=True):
        self.isjunk = isjunk
        self.autojunk = autojunk
        self.a = None
        self.b = None
        self.set_seqs(a, b)

    def set_seqs(self, a, b):
        self.set_seq1(a)
        self.set_seq2(b)

    def set_seq1(self, a):
        if a is self.a:
            return
        self.a = a
        self._blocks = None
        self._codes = None

    def set_seq2(self, b):
        if b is self.b:
            return
        self.b = b
        self._blocks = None
        self._codes = None
        self._bcount = None
        self._index_b()

    def _index_b(self):
        index = {}
        for pos, item in enumerate(self.b):
            index.setdefault(item, []).append(pos)
        junk = set()
        if self.isjunk:
            for item in list(index):
                if self.isjunk(item):
                    junk.add(item)
            for item in junk:
                del index[item]
        popular = set()
        nb = len(self.b)
        if self.autojunk and nb >= 200:
            limit = nb // 100 + 1
            for item, where in index.items():
                if len(where) > limit:
                    popular.add(item)
            for item in popular:
                del index[item]
        self.b2j = index
        self.bjunk = junk
        self.bpopular = popular

    def find_longest_match(self, alo=0, ahi=None, blo=0, bhi=None):
        a, b, index, junk = self.a, self.b, self.b2j, self.bjunk
        if ahi is None:
            ahi = len(a)
        if bhi is None:
            bhi = len(b)
        bi, bj, size = alo, blo, 0
        runs = {}
        for i in range(alo, ahi):
            nxt = {}
            for j in index.get(a[i], ()):
                if j < blo:
                    continue
                if j >= bhi:
                    break
                k = runs.get(j - 1, 0) + 1
                nxt[j] = k
                if k > size:
                    bi, bj, size = i - k + 1, j - k + 1, k
            runs = nxt
        # grow with equal non-junk neighbours, then with equal junk neighbours
        for want_junk in (False, True):
            while (bi > alo and bj > blo and (b[bj - 1] in junk) == want_junk
                   and a[bi - 1] == b[bj - 1]):
                bi -= 1
                bj -= 1
                size += 1
            while (bi + size < ahi and bj + size < bhi
                   and (b[bj + size] in junk) == want_junk
                   and a[bi + size] == b[bj + size]):
                size += 1
        return Match(bi, bj, size)

    def get_matching_blocks(self):
        if self._blocks is not None:
            return self._blocks
        la, lb = len(self.a), len(self.b)
        todo = [(0, la, 0, lb)]
        found = []
        while todo:
            alo, ahi, blo, bhi = todo.pop()
            m = self.find_longest_match(alo, ahi, blo, bhi)
            i, j, k = m
            if k:
                found.append(m)
                if alo < i and blo < j:
                    todo.append((alo, i, blo, j))
                if i + k < ahi and j + k < bhi:
                    todo.append((i + k, ahi, j + k, bhi))
        found.sort()
        merged = []
        ci = cj = ck = 0
        for i, j, k in found:
            if ci + ck == i and cj + ck == j:
                ck += k
            else:
                if ck:
                    merged.append(Match(ci, cj, ck))
                ci, cj, ck = i, j, k
        if ck:
            merged.append(Match(ci, cj, ck))
        merged.append(Match(la, lb, 0))
        self._blocks = merged
        return merged

    def get_opcodes(self):
        if self._codes is not None:
            return self._codes
        i = j = 0
        out = []
        for ai, bj, size in self.get_matching_blocks():
            if i < ai and j < bj:
                out.append(("replace", i, ai, j, bj))
            elif i < ai:
                out.append(("delete", i, ai, j, bj))
            elif j < bj:
                out.append(("insert", i, ai, j, bj))
            i, j = ai + size, bj + size
            if size:
                out.append(("equal", ai, i, bj, j))
        self._codes = out
        return out

    def get_grouped_opcodes(self, n=3):
        codes = list(self.get_opcodes())
        if not codes:
            codes = [("equal", 0, 1, 0, 1)]
        if codes[0][0] == "equal":
            t, i1, i2, j1, j2 = codes[0]
            codes[0] = (t, max(i1, i2 - n), i2, max(j1, j2 - n), j2)
        if codes[-1][0] == "equal":
            t, i1, i2, j1, j2 = codes[-1]
            codes[-1] = (t, i1, min(i2, i1 + n), j1, min(j2, j1 + n))
        group = []
        for t, i1, i2, j1, j2 in codes:
            if t == "equal" and i2 - i1 > 2 * n:
                group.append((t, i1, min(i2, i1 + n), j1, min(j2, j1 + n)))
                yield group
                group = []
                i1, j1 = max(i1, i2 - n), max(j1, j2 - n)
            group.append((t, i1, i2, j1, j2))
        if group and not (len(group) == 1 and group[0][0] == "equal"):
            yield group

    def ratio(self):
        total = sum(m[2] for m in self.get_matching_blocks())
        return _ratio(total, len(self.a) + len(self.b))

    def quick_ratio(self):
        if self._bcount is None:
            cnt = {}
            for x in self.b:
                cnt[x] = cnt.get(x, 0) + 1
            self._bcount = cnt
        left = dict(self._bcount)
        hits = 0
        for x in self.a:
            have = left.get(x, 0)
            left[x] = have - 1
            if have > 0:
                hits += 1
        return _ratio(hits, len(self.a) + len(self.b))

    def real_quick_ratio(self):
        la, lb = len(self.a), len(self.b)
        return _ratio(min(la, lb), la + lb)


def get_close_matches(word, possibilities, n=3, cutoff=0.6):
    if not n > 0:
        raise ValueError("n must be > 0: %r" % (n,))
    if not 0.0 <= cutoff <= 1.0:
        raise ValueError("cutoff must be in [0.0, 1.0]: %r" % (cutoff,))
    scored = []
    s = SequenceMatcher()
    s.set_seq2(word)
    for x in possibilities:
        s.set_seq1(x)
        if (s.real_quick_ratio() >= cutoff and s.quick_ratio() >= cutoff
                and s.ratio() >= cutoff):
            scored.append((s.ratio(), x))
    scored.sort(reverse=True)
    return [x for _, x in scored[:n]]


def IS_LINE_JUNK(line):
    i, n = 0, len(line)
    while i < n and line[i].isspace():
        i += 1
    if i < n and line[i] == "#":
        i += 1
        while i < n and line[i].isspace():
            i += 1
    return i == n


def IS_CHARACTER_JUNK(ch, ws=" \t"):
    return ch in ws


# ------------------------------------------------------------------ Differ

def _dump(tag, x, lo, hi):
    return ["%s %s" % (tag, x[i]) for i in range(lo, hi)]


def _plain_replace(a, alo, ahi, b, blo, bhi):
    if bhi - blo < ahi - alo:
        return _dump("+", b, blo, bhi) + _dump("-", a, alo, ahi)
    return _dump("-", a, alo, ahi) + _dump("+", b, blo, bhi)


def _keep_ws(s, tags):
    return "".join(c if t == " " and c.isspace() else t for c, t in zip(s, tags))


def _fancy_replace(a, alo, ahi, b, blo, bhi, charjunk):
    best, cutoff = 0.74, 0.75
    sm = SequenceMatcher(charjunk)
    eqi = eqj = None
    best_i = best_j = None
    for j in range(blo, bhi):
        bj = b[j]
        sm.set_seq2(bj)
        for i in range(alo, ahi):
            ai = a[i]
            if ai == bj:
                if eqi is None:
                    eqi, eqj = i, j
                continue
            sm.set_seq1(ai)
            if (sm.real_quick_ratio() > best and sm.quick_ratio() > best
                    and sm.ratio() > best):
                best, best_i, best_j = sm.ratio(), i, j
    if best < cutoff:
        if eqi is None:
            return _plain_replace(a, alo, ahi, b, blo, bhi)
        best_i, best_j = eqi, eqj
    else:
        eqi = None
    out = _fancy_helper(a, alo, best_i, b, blo, best_j, charjunk)
    aelt, belt = a[best_i], b[best_j]
    if eqi is None:
        atags = btags = ""
        sm.set_seqs(aelt, belt)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            la, lb = i2 - i1, j2 - j1
            if tag == "replace":
                atags += "^" * la
                btags += "^" * lb
            elif tag == "delete":
                atags += "-" * la
            elif tag == "insert":
                btags += "+" * lb
            else:
                atags += " " * la
                btags += " " * lb
        atags = _keep_ws(aelt, atags).rstrip()
        btags = _keep_ws(belt, btags).rstrip()
        out.append("- " + aelt)
        if atags:
            out.append("? %s\n" % atags)
        out.append("+ " + belt)
        if btags:
            out.append("? %s\n" % btags)
    else:
        out.append("  " + aelt)
    out.extend(_fancy_helper(a, best_i + 1, ahi, b, best_j + 1, bhi, charjunk))
    return out


def _fancy_helper(a, alo, ahi, b, blo, bhi, charjunk):
    if alo < ahi:
        if blo < bhi:
            return _fancy_replace(a, alo, ahi, b, blo, bhi, charjunk)
        return _dump("-", a, alo, ahi)
    if blo < bhi:
        return _dump("+", b, blo, bhi)
    return []


def ndiff(a, b, linejunk=None, charjunk=IS_CHARACTER_JUNK):
    sm = SequenceMatcher(linejunk, a, b)
    for tag, alo, ahi, blo, bhi in sm.get_opcodes():
        if tag == "replace":
            yield from _fancy_replace(a, alo, ahi, b, blo, bhi, charjunk)
        elif tag == "delete":
            yield from _dump("-", a, alo, ahi)
        elif tag == "insert":
            yield from _dump("+", b, blo, bhi)
        else:
            yield from _dump(" ", a, alo, ahi)


def restore(delta, which):
    try:
        tag = {1: "- ", 2: "+ "}[int(which)]
    except KeyError:
        raise ValueError("unknown delta choice (must be 1 or 2): %r" % (which,)) from None
    for line in delta:
        if line[:2] in ("  ", tag):
            yield line[2:]


# ------------------------------------------------------- unified / context

def _range_unified(start, stop):
    first = start + 1
    length = stop - start
    if length == 1:
        return "%d" % first
    if not length:
        first -= 1
    return "%d,%d" % (first, length)


def _range_context(start, stop):
    first = start + 1
    length = stop - start
    if not length:
        first -= 1
    if length <= 1:
        return "%d" % first
    return "%d,%d" % (first, first + length - 1)


def _header(name, date, lineterm, mark):
    return "%s %s%s%s" % (mark, name, ("\t" + date) if date else "", lineterm)


def unified_diff(a, b, fromfile="", tofile="", fromfiledate="", tofiledate="",
                 n=3, lineterm="\n"):
    started = False
    for group in SequenceMatcher(None, a, b).get_grouped_opcodes(n):
        if not started:
            started = True
            yield _header(fromfile, fromfiledate, lineterm, "---")
            yield _header(tofile, tofiledate, lineterm, "+++")
        r1 = _range_unified(group[0][1], group[-1][2])
        r2 = _range_unified(group[0][3], group[-1][4])
        yield "@@ -%s +%s @@%s" % (r1, r2, lineterm)
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                for line in a[i1:i2]:
                    yield " " + line
                continue
            if tag in ("replace", "delete"):
                for line in a[i1:i2]:
                    yield "-" + line
            if tag in ("replace", "insert"):
                for line in b[j1:j2]:
                    yield "+" + line


_PREFIX = {"insert": "+ ", "delete": "- ", "replace": "! ", "equal": "  "}


def context_diff(a, b, fromfile="", tofile="", fromfiledate="", tofiledate="",
                 n=3, lineterm="\n"):
    started = False
    for group in SequenceMatcher(None, a, b).get_grouped_opcodes(n):
        if not started:
            started = True
            yield _header(fromfile, fromfiledate, lineterm, "***")
            yield _header(tofile, tofiledate, lineterm, "---")
        yield "***************" + lineterm
        yield "*** %s ****%s" % (_range_context(group[0][1], group[-1][2]), lineterm)
        if any(g[0] in ("replace", "delete") for g in group):
            for tag, i1, i2, _, _ in group:
                if tag != "insert":
                    for line in a[i1:i2]:
                        yield _PREFIX[tag] + line
        yield "--- %s ----%s" % (_range_context(group[0][3], group[-1][4]), lineterm)
        if any(g[0] in ("replace", "insert") for g in group):
            for tag, _, _, j1, j2 in group:
                if tag != "delete":
                    for line in b[j1:j2]:
                        yield _PREFIX[tag] + line
