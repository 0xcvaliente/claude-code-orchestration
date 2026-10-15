# toolkit.fraction

A pure-Python rational number class in `toolkit/fraction.py` that behaves
like `fractions.Fraction` from the Python 3.13 standard library for the
subset below. The hidden tests run the same expression with
`toolkit.fraction.Fraction` and with `fractions.Fraction` and compare the
results. The solution may not import `fractions` (or any other module on
the blocked list in SPEC.md); `decimal`, `math`, `numbers`, `operator`,
`functools` and `sys` are allowed.

## How results are compared

- A `Fraction` result is compared by exact type (it must be an instance of
  your `Fraction` class itself, not a subclass and not an `int`), numerator
  and denominator. Numerators and denominators must be plain `int`.
- `int`, `bool` and `str` results must have exactly that type and value
  (`True` is not accepted for `1`, nor `1` for `True`).
- `float` results must be `float` and equal within a relative tolerance of
  1e-12 (two NaNs are equal; infinities must match exactly).
- Tuples (from `divmod` and `as_integer_ratio`) must be tuples with each
  element compared as above.
- Exceptions: only the exception class name is compared, never the
  message. The kinds used are `ZeroDivisionError`, `ValueError`,
  `TypeError` and `OverflowError`.
- Some tests evaluate several expressions; each expression is compared on
  its own as above, and the test passes only when all of them match.

## Construction: `Fraction(numerator=0, denominator=None)`

The result is always normalized: `gcd(numerator, denominator) == 1` and the
denominator is positive (the sign is carried by the numerator; zero is
`0/1`).

One argument:

- `int`: that integer over 1. `Fraction()` is `0/1`.
- a `Fraction`: the same value.
- `float` or `decimal.Decimal`: the exact value (`Fraction(0.1)` is
  `3602879701896397/36028797018963968`, `Fraction(-0.0)` is `0/1`).
  NaN raises `ValueError`; an infinity raises `OverflowError`.
- `str`: see "String forms".
- anything else (for example `None`): `TypeError`.

Two arguments: both must be `int` or `Fraction` (a mix is fine); the value
is `numerator / denominator`. A `float`, `str` or `Decimal` in either
position raises `TypeError`. A zero denominator (`Fraction(7, 0)`,
`Fraction(Fraction(1, 2), Fraction(0))`) raises `ZeroDivisionError`.

### String forms

Accepted (ASCII only in the tests):

```
[whitespace] [sign] number [whitespace]
number   := digits "/" digits         (optional whitespace around "/")
          | digits ["." [digits]] [exponent]
          | "." digits [exponent]
digits   := one or more 0-9, with single underscores allowed between
            digits ("1_000"), never leading, trailing or doubled
exponent := ("e" | "E") [sign] digits
sign     := "+" | "-"
```

Examples: `"3/4"`, `" -12/8 "`, `"+5"`, `"1.25"`, `"-.5"`, `"5."`,
`"1e3"`, `"2.5E-3"`, `"1.e2"`, `"-1_000.000_1"`, `"1_0/2_0"`,
`"  7 / 3\n"`, `"007"`. The value is exact (`"2.5E-3"` is `1/400`). The
sign applies to the whole number, and only before it: `"1/-2"`, `"- 1"`
and `"+-1"` are invalid. A fraction form cannot have a decimal point or
exponent (`"1.5/2"` is invalid). `"1/0"` raises `ZeroDivisionError`.
Anything else raises `ValueError`, including `""`, whitespace only, `"."`,
`".e1"`, `"e5"`, `"1e"`, `"1e1.5"`, `"1__0"`, `"_1"`, `"1_"`, `"1._5"`,
`"0x10"`, `"1 2"`, `"inf"`, `"nan"`, `"1/2/3"` and trailing garbage.

## Attributes and methods

- `numerator`, `denominator`: the normalized parts (plain `int`).
- `as_integer_ratio()`: the tuple `(numerator, denominator)`.
- `is_integer()`: `True` iff the denominator is 1.
- `limit_denominator(max_denominator=1000000)`: the closest `Fraction` to
  self with denominator at most `max_denominator` (as `fractions` computes
  it, via continued fractions; when two candidates are equally close the
  one `fractions` returns, which is the convergent `p1/q1`, wins).
  `max_denominator < 1` raises `ValueError`. Examples: `pi` approximated
  as `3141592653589793/10**15` gives `3/1` for 1, `22/7` for 10, `311/99`
  for 100, `355/113` for 1000, `3126535/995207` by default.
- `Fraction.from_float(f)`: classmethod; a `float` converts exactly, an
  `int` converts to `int/1`, anything else (including a `Fraction` or a
  `str`) raises `TypeError`; NaN raises `ValueError`, infinity
  `OverflowError`.
- `Fraction.from_decimal(d)`: classmethod; a `Decimal` converts exactly,
  an `int` converts to `int/1`, anything else (including a `float`) raises
  `TypeError`; a NaN `Decimal` raises `ValueError`, an infinite one
  `OverflowError`.

## Conversions and unary operations

- `str(x)`: `"n/d"`, or just `"n"` when the denominator is 1.
- `repr(x)`: `"Fraction(n, d)"` (always both parts).
- `abs(x)`, `-x`, `+x`: `Fraction`.
- `math.trunc(x)`, `math.floor(x)`, `math.ceil(x)`, `int(x)`: `int`
  (`int` truncates toward zero).
- `round(x)`: `int`, rounding half to even. `round(x, ndigits)` (any int
  `ndigits`, also 0 or negative) returns a `Fraction`: the multiple of
  `10**-ndigits` nearest to `x`, half to even (`round(Fraction(25, 1000), 2)`
  is `1/50`, `round(Fraction(250), -2)` is `200`).
- `float(x)`: the correctly rounded value of numerator / denominator.
- `bool(x)`: `False` iff `x` is zero.
- `hash(x)`: must equal `hash(fractions.Fraction(x))`, which is Python's
  numeric hash: with `P = sys.hash_info.modulus`, if the denominator is
  divisible by `P` the hash is `sys.hash_info.inf`; otherwise it is
  `hash(hash(abs(n)) * pow(d, -1, P))`, negated for negative `n`, with
  `-1` mapped to `-2`. So `hash(Fraction(3)) == 3`,
  `hash(Fraction(1, 2)) == hash(0.5)`, `hash(Fraction(-1)) == -2`.

## Binary arithmetic: `+ - * / // % divmod **`

Operands: a `Fraction` combined with an `int`, another `Fraction` or a
`float`, on either side.

- `Fraction` with `int` or `Fraction`: `+ - * / %` give a `Fraction`;
  `//` gives an `int` (floor of the exact quotient); `divmod(a, b)` gives
  `(a // b, a % b)` as `(int, Fraction)`. `%` has the sign of the divisor
  (as for ints): `a % b == a - b * (a // b)`.
- With a `float` on either side: the `Fraction` is converted with
  `float()` and the operation is done in floats, so the result is a
  `float` (`divmod` gives a tuple of two floats).
- Division by zero (`/`, `//`, `%`, `divmod` with a zero `Fraction` or
  `int`, or `/` by `0.0`) raises `ZeroDivisionError`.
- Operands of other types (`str`, `None`, `Decimal`) raise `TypeError`,
  on either side.

Powers:

- `Fraction ** int` (and `Fraction ** Fraction` whose denominator is 1):
  exact `Fraction`; negative exponents invert (`(-2/3) ** -3` is `-27/8`);
  anything `** 0` is `1`; `Fraction(0) ** negative` raises
  `ZeroDivisionError`.
- `Fraction ** Fraction` with denominator other than 1, and
  `Fraction ** float`: `float(a) ** float(b)`, a `float`.
- `int ** Fraction`: if the exponent's denominator is 1 and its numerator
  is >= 0, the result is `int ** numerator` (an `int`); if the denominator
  is 1 and the numerator is negative, an exact `Fraction`
  (`2 ** Fraction(-2)` is `1/4`); otherwise a `float`.
- `float ** Fraction`: a `float` (`float ** numerator` when the
  denominator is 1, else `float ** float(exponent)`).
- `Fraction ** str` raises `TypeError`.

## Comparisons: `< <= > >= == !=`

With `int`, `Fraction` and `float` on either side, results are `bool`.
Comparison with a finite float is exact (the float is converted exactly:
`Fraction(1, 10) > 0.1` is `True`, `Fraction(1, 2) == 0.5` is `True`).
Against `inf`, `-inf` and NaN a `Fraction` behaves like any finite number
(`x < inf` is `True`, every comparison with NaN is `False` except `!=`).
`==` with an unrelated type (for example a `str`) is `False` (`!=` is
`True`); ordering comparisons with a `str` or `None` raise `TypeError`.

## `format(x, spec)`

Two families of format specifications are supported; anything else
raises `ValueError`.

1. No presentation type: `[[fill]align][sign]["#"][width][grouping]`,
   where `align` is one of `< > = ^`, `fill` any character, `sign` one of
   `+ - space`, `width` is `0` or a number without a leading zero, and
   `grouping` is `,` or `_`. The body is `str(abs(x))`-like: `n/d`, or
   just `n` when the denominator is 1 unless `#` is given (then `n/1`).
   Grouping separators are applied to the numerator and the denominator
   separately. The sign is `-` for negative values, else the `+` or space
   from `sign` (nothing for `-` or no sign). Default alignment is `>`; `=`
   puts the padding between sign and body; `^` puts the extra padding
   character on the right. The empty spec gives `str(x)`.
2. Float style: `[[fill]align][sign]["z"]["#"]["0"][width][grouping]["." precision]type`
   with `type` one of `e E f F g G %`. Formats the exact rational value
   like the float formatting of the same type would format the exact
   value (correctly rounded, ties to even, no float conversion):
   default precision 6; `%` multiplies by 100 and appends `%`; `g`/`G`
   use scientific notation when the exponent is < -4 or >= precision
   (precision 0 is treated as 1) and strip trailing zeros unless `#` is
   given; `#` keeps the decimal point; `z` turns a negative zero result
   into positive zero; a `0` directly before the width (`"010.2f"`), or
   fill `0` with `=` alignment, zero-pads after the sign (grouping
   separators are inserted into the zero padding too); exponents have at
   least two digits (`e+00`); `E`, `F` and `G` behave like `e`, `f` and `g`
   but write the exponent marker as `E`. Combining an explicit alignment with the
   `0` flag (`"=010.2f"`) raises `ValueError`. In this family a `0`
   followed by another digit is the zero flag plus width; a precision may
   not have a leading zero (`".05f"` is invalid).

Invalid examples (all `ValueError`): `"05"`, `"010"` (zero flag without a
type), `".2"`, `"d"`, `",d"`, `"s"`, `"z"`, `".05f"`, `"=010.2f"`.

## Never tested

Complex numbers (including results that would be complex, such as a
negative base raised to a non-integer power), operations between a
`Fraction` and a `Decimal` other than the `TypeError` cases above,
comparisons with `Decimal`, `Fraction(x, y)` with non-`int` rational types
other than `Fraction`, `math.floor`/`ceil` of huge values beyond what the
tests above use, non-ASCII strings, the `numbers` ABC registration,
pickling and copying, subclassing, `__format__` with a non-ASCII fill,
`int ** Fraction` with a negative base and a non-integer exponent, and
the three-argument `pow`.
