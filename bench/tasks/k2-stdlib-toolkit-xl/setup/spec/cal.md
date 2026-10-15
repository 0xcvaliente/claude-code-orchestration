# toolkit.cal

Calendar computations and plain-text calendars in `toolkit/cal.py` that
behave like the Python 3.13 standard library module `calendar` for the
subset below. The hidden tests run the same call on `toolkit.cal` and on
`calendar` and compare the results. The solution may not import
`calendar`, or any other module on the blocked list in SPEC.md;
`datetime` is allowed (and needed for `datetime.date` results).

All years in tests are 1..9999 unless a function's section says otherwise.

## Comparison

Results are normalized before comparison: tuples and lists both become
lists (so `monthrange` may return either), integer-like results are
compared with `int(x)` (an `IntEnum` is fine), `datetime.date` values are
compared by year, month and day, and the results of the `iter*` methods
are collected with `list(...)`, so any iterable works. Strings are compared
exactly, including every space and newline.

Errors are compared by kind only: `IllegalMonthError` (and its `month`
attribute), `IllegalWeekdayError` (and its `weekday` attribute), otherwise
`ValueError`, `IndexError` or `TypeError`. Messages are never compared.

## Constants and errors

- `MONDAY`, `TUESDAY`, `WEDNESDAY`, `THURSDAY`, `FRIDAY`, `SATURDAY`,
  `SUNDAY` = 0..6.
- `IllegalMonthError(month)`: subclass of both `ValueError` and
  `IndexError`; stores the bad value as `.month`.
- `IllegalWeekdayError(weekday)`: subclass of `ValueError`; stores the bad
  value as `.weekday`.
- Every function or method below that takes a `(year, month)` pair (all
  of `monthrange`, `monthcalendar`, `month`, the `itermonth*` and
  `month*calendar` methods, `formatmonth`) raises `IllegalMonthError(month)`
  when `month` is not in 1..12, before anything else. `weekday` and
  `timegm` are the exception: there an invalid month or day raises
  `ValueError` (as `datetime.date` does).

## Module functions

- `isleap(year)`: Gregorian rule (divisible by 4, except centuries not
  divisible by 400).
- `leapdays(y1, y2)`: number of leap years in `range(y1, y2)`, computed as
  `(b//4 - a//4) - (b//100 - a//100) + (b//400 - a//400)` with
  `a = y1 - 1`, `b = y2 - 1`; for `y1 > y2` this gives minus the count for
  `range(y2, y1)`.
- `weekday(year, month, day)`: day of the week, 0 = Monday. An invalid date
  (month 0 or 13, day 0, February 29 of a common year, April 31, ...)
  raises `ValueError`.
- `monthrange(year, month)`: `(weekday of the 1st, number of days)`.
- `timegm(t)`: `t` is a tuple; only its first six items `(year, month,
  day, hour, minute, second)` are used (extra items are ignored). The
  result is `((days * 24 + hour) * 60 + minute) * 60 + second` where
  `days` is the number of days from 1970-01-01 to the 1st of `month` in
  `year`, plus `day - 1`. Only year and month are validated (an invalid
  month raises `ValueError`); `day`, `hour`, `minute` and `second` may be
  out of their usual ranges and are simply added (day 40 or hour 25 is
  fine). A float `second` gives a float result. Dates before 1970 give
  negative results.
- A module-level `TextCalendar` instance backs these functions:
  `firstweekday()` returns its first weekday; `setfirstweekday(n)` sets it
  when `0 <= n <= 6` and otherwise raises `IllegalWeekdayError(n)` and
  leaves it unchanged; `monthcalendar(year, month)` is its
  `monthdayscalendar`, `weekheader(width)` its `formatweekheader`,
  `month(theyear, themonth, w=0, l=0)` its `formatmonth` and
  `calendar(theyear, w=2, l=1, c=6, m=3)` its `formatyear`. Tests call
  `setfirstweekday` before each module-level call and reset it to 0
  afterwards.

## Name sequences

`day_name`, `day_abbr`, `month_name` and `month_abbr` are read-only
sequences of English names (the C locale): `day_name` is
`Monday`..`Sunday`, `day_abbr` is `Mon`..`Sun`, `month_name` has 13 entries
with `month_name[0] == ""` followed by `January`..`December`, and
`month_abbr` is `""`, `Jan`..`Dec`. They support `len()`, integer indexing
including negative indexes (an out-of-range index raises `IndexError`),
slicing (`month_name[1:4]`, `day_name[-2:]`; the result is compared as a
list) and iteration.

## Calendar

`Calendar(firstweekday=0)`:

- `firstweekday` is a property: setting it (or calling
  `setfirstweekday(n)`) stores `n` without validation; reading it (or
  `getfirstweekday()`) returns the stored value `% 7`. So `Calendar(9)` and
  `Calendar(-5)` both start weeks on Wednesday (2). Below, "fw" is that
  value modulo 7.
- `iterweekdays()`: the 7 weekday numbers starting at fw.
- A month is always shown as complete weeks of 7 days starting on fw: the
  days of the previous month that share the first week come first, then
  the month's days, then days of the next month to fill the last week.
  A month therefore spans 4 to 6 weeks.
- `itermonthdays3(year, month)`: `(year, month, day)` tuples for all of
  those days. Previous/next months are computed arithmetically, so January
  of year 1 may start with `(0, 12, 31)` and December of 9999 may end with
  `(10000, 1, d)`; no error is raised.
- `itermonthdays4(year, month)`: the same with a fourth item, the weekday
  number of that day.
- `itermonthdates(year, month)`: the same days as `datetime.date` objects.
  When one of them falls in year 0 or year 10000, `ValueError` is raised.
- `itermonthdays(year, month)`: day numbers, with 0 for days outside the
  month.
- `itermonthdays2(year, month)`: `(day number or 0, weekday number)` pairs.
- `monthdatescalendar`, `monthdays2calendar`, `monthdayscalendar`
  `(year, month)`: the items of `itermonthdates`, `itermonthdays2` and
  `itermonthdays` split into a list of weeks (lists of 7).
- `yeardatescalendar(year, width=3)`: the 12 `monthdatescalendar(year, m)`
  results split into rows of `width` months (the last row may be shorter);
  `width` is 1..12 in tests. It raises `ValueError` like
  `itermonthdates` (year 1 or 9999 with an unlucky fw).

## TextCalendar

`TextCalendar(firstweekday=0)` is a `Calendar` with text formatting.
"centered in n" below means Python's `s.center(n)` (which does nothing
when `s` is at least `n` long).

- `formatweekheader(width)`: for each weekday from `iterweekdays()`, the
  full name (`day_name`) if `width >= 9`, else the abbreviation
  (`day_abbr`), cut to its first `width` characters and centered in
  `width`; the 7 parts joined by single spaces. `width` is 0..20 in tests
  (width 0 gives six spaces).
- `formatmonth(theyear, themonth, w=0, l=0)`: first `w = max(2, w)` and
  `l = max(1, l)`. Then the string is, in order:
  1. the title `"<month name> <year>"` (the year as `repr(theyear)`, no
     padding) centered in `7 * (w + 1) - 1`, right-stripped, then `l`
     newlines;
  2. `formatweekheader(w)` right-stripped, then `l` newlines;
  3. for each week of `monthdays2calendar(theyear, themonth)`: each day
     as `"%2i" % day` (an empty string for 0) centered in `w`, the 7
     joined by single spaces, right-stripped, then `l` newlines.
- `formatyear(theyear, w=2, l=1, c=6, m=3)`: first `w = max(2, w)`,
  `l = max(1, l)`, `c = max(2, c)`, and `colwidth = (w + 1) * 7 - 1`; `m`
  is 1..12 in tests. The string is `repr(theyear)` centered in
  `colwidth * m + c * (m - 1)` and right-stripped, then `l` newlines, then
  for each row of `m` consecutive months (January first; the last row may
  have fewer):
  1. `l` newlines;
  2. the month names (no year) each centered in `colwidth`, joined by `c`
     spaces, right-stripped, then `l` newlines;
  3. `formatweekheader(w)` once per month in the row, each centered in
     `colwidth`, joined by `c` spaces, right-stripped, then `l` newlines;
  4. for each week index `j` up to the largest number of weeks among the
     row's months: for each month its week `j` formatted as in
     `formatmonth` step 3 but not stripped (an empty string when that
     month has fewer weeks), each centered in `colwidth`, joined by `c`
     spaces, right-stripped, then `l` newlines.

## Never tested

`HTMLCalendar`, `LocaleTextCalendar`, `LocaleHTMLCalendar`, the printing
functions and methods (`prmonth`, `prcal`, `prweek`, `pryear`), `format`,
`formatstring`, `week`, `main` and the command line, the `Day` and `Month`
enum classes and the `JANUARY`..`DECEMBER` constants, `yeardays2calendar`
and `yeardayscalendar` directly, `formatday`, `formatweek`,
`formatweekday` and `formatmonthname` directly, locales other than C,
years outside 1..9999 as arguments, non-integer arguments (except a float
second in `timegm`), `width < 1` for `yeardatescalendar`, `m < 1` for
`formatyear`, and error messages.
