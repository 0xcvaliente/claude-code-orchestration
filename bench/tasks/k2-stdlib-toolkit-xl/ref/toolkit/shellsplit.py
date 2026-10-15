"""Shell-like splitting and quoting with the same results as Python 3.13 shlex."""

__all__ = ["split", "quote", "join"]

WHITESPACE = " \t\r\n"
QUOTES = "'\""
ESCAPE = "\\"
ESCAPED_QUOTES = '"'
SAFE = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-")


class _Lexer:
    def __init__(self, s, posix, commenters):
        self.s = s
        self.i = 0
        self.posix = posix
        self.commenters = commenters
        self.state = " "
        self.pushback = []

    def read(self):
        if self.i < len(self.s):
            c = self.s[self.i]
            self.i += 1
            return c
        return ""

    def readline(self):
        j = self.s.find("\n", self.i)
        self.i = len(self.s) if j < 0 else j + 1

    def read_token(self):
        posix = self.posix
        quoted = False
        escapedstate = " "
        token = ""
        while True:
            nextchar = self.read()
            state = self.state
            if state is None:
                token = ""
                break
            if state == " ":
                if not nextchar:
                    self.state = None
                    break
                if nextchar in WHITESPACE:
                    if token or (posix and quoted):
                        break
                    continue
                if nextchar in self.commenters:
                    self.readline()
                elif posix and nextchar == ESCAPE:
                    escapedstate = "a"
                    self.state = nextchar
                elif nextchar in QUOTES:
                    if not posix:
                        token = nextchar
                    self.state = nextchar
                else:
                    token = nextchar
                    self.state = "a"
            elif state in QUOTES:
                quoted = True
                if not nextchar:
                    raise ValueError("No closing quotation")
                if nextchar == state:
                    if not posix:
                        token += nextchar
                        self.state = " "
                        break
                    self.state = "a"
                elif posix and nextchar == ESCAPE and state in ESCAPED_QUOTES:
                    escapedstate = state
                    self.state = nextchar
                else:
                    token += nextchar
            elif state == ESCAPE:
                if not nextchar:
                    raise ValueError("No escaped character")
                if escapedstate in QUOTES and nextchar != state and nextchar != escapedstate:
                    token += state
                token += nextchar
                self.state = escapedstate
            else:  # state "a"
                if not nextchar:
                    self.state = None
                    break
                if nextchar in WHITESPACE:
                    self.state = " "
                    if token or (posix and quoted):
                        break
                    continue
                if nextchar in self.commenters:
                    self.readline()
                    if posix:
                        self.state = " "
                        if token or (posix and quoted):
                            break
                        continue
                elif posix and nextchar in QUOTES:
                    self.state = nextchar
                elif posix and nextchar == ESCAPE:
                    escapedstate = "a"
                    self.state = nextchar
                else:
                    token += nextchar
        if posix and not quoted and token == "":
            return None
        return token


def split(s, comments=False, posix=True):
    if s is None:
        raise ValueError("s argument must not be None")
    lex = _Lexer(s, posix, "#" if comments else "")
    eof = None if posix else ""
    out = []
    while True:
        tok = lex.read_token()
        if tok == eof:
            return out
        out.append(tok)


def quote(s):
    if not s:
        return "''"
    if all(c in SAFE for c in s):
        return s
    return "'" + s.replace("'", "'\"'\"'") + "'"


def join(split_command):
    return " ".join(quote(arg) for arg in split_command)
