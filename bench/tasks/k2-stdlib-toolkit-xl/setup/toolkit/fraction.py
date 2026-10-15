"""toolkit.fraction: a pure-Python rational number type compatible with the
standard library's `fractions.Fraction` for the subset in spec/fraction.md.

This is a stub.  The public names exist so imports succeed; replace the
bodies.  Do not import fractions or any other blocked module (decimal, math,
numbers, operator, functools and sys are fine).
"""


class Fraction:
    """Rational number numerator/denominator, always normalized."""

    def __new__(cls, numerator=0, denominator=None):
        raise NotImplementedError("toolkit.fraction.Fraction")

    @classmethod
    def from_float(cls, f):
        raise NotImplementedError("toolkit.fraction.Fraction.from_float")

    @classmethod
    def from_decimal(cls, dec):
        raise NotImplementedError("toolkit.fraction.Fraction.from_decimal")

    @property
    def numerator(self):
        raise NotImplementedError("toolkit.fraction.Fraction.numerator")

    @property
    def denominator(self):
        raise NotImplementedError("toolkit.fraction.Fraction.denominator")

    def as_integer_ratio(self):
        raise NotImplementedError("toolkit.fraction.Fraction.as_integer_ratio")

    def is_integer(self):
        raise NotImplementedError("toolkit.fraction.Fraction.is_integer")

    def limit_denominator(self, max_denominator=1000000):
        raise NotImplementedError("toolkit.fraction.Fraction.limit_denominator")

    # Also needed (see the spec): __repr__, __str__, __format__, __hash__,
    # __eq__/__lt__/__le__/__gt__/__ge__, __bool__, __abs__, __neg__, __pos__,
    # __trunc__, __floor__, __ceil__, __round__, __int__, __float__,
    # __add__/__radd__, __sub__/__rsub__, __mul__/__rmul__,
    # __truediv__/__rtruediv__, __floordiv__/__rfloordiv__,
    # __mod__/__rmod__, __divmod__/__rdivmod__, __pow__/__rpow__.
