"""toolkit.cal: calendar computations and plain-text calendars compatible
with the Python 3.13 `calendar` module for the subset in spec/cal.md
(reference solution)."""

import datetime

__all__ = ["IllegalMonthError", "IllegalWeekdayError", "setfirstweekday",
           "firstweekday", "isleap", "leapdays", "weekday", "monthrange",
           "monthcalendar", "month", "calendar", "weekheader", "timegm",
           "month_name", "month_abbr", "day_name", "day_abbr", "Calendar",
           "TextCalendar", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY",
           "FRIDAY", "SATURDAY", "SUNDAY"]


class IllegalMonthError(ValueError, IndexError):
    def __init__(self, month):
        self.month = month

    def __str__(self):
        return "bad month number %r; must be 1-12" % (self.month,)


class IllegalWeekdayError(ValueError):
    def __init__(self, weekday):
        self.weekday = weekday

    def __str__(self):
        return "bad weekday number %r; must be 0 (Monday) to 6 (Sunday)" % (
            self.weekday,)


MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY = range(7)
JANUARY, FEBRUARY = 1, 2

_MDAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


class _Names:
    def __init__(self, names):
        self._names = list(names)

    def __getitem__(self, i):
        return self._names[i]

    def __len__(self):
        return len(self._names)

    def __iter__(self):
        return iter(self._names)


_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
         "Sunday"]
_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]

day_name = _Names(_DAYS)
day_abbr = _Names(d[:3] for d in _DAYS)
month_name = _Names([""] + _MONTHS)
month_abbr = _Names([""] + [m[:3] for m in _MONTHS])


def isleap(year):
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def leapdays(y1, y2):
    y1 -= 1
    y2 -= 1
    return (y2 // 4 - y1 // 4) - (y2 // 100 - y1 // 100) + (y2 // 400 - y1 // 400)


def weekday(year, month, day):
    if not 1 <= year <= 9999:
        year = 2000 + year % 400
    return datetime.date(year, month, day).weekday()


def _monthlen(year, month):
    return _MDAYS[month] + (month == 2 and isleap(year))


def monthrange(year, month):
    if not 1 <= month <= 12:
        raise IllegalMonthError(month)
    return weekday(year, month, 1), _monthlen(year, month)


def _chunks(seq, n):
    return [seq[i:i + n] for i in range(0, len(seq), n)]


class Calendar:
    def __init__(self, firstweekday=0):
        self.firstweekday = firstweekday

    def getfirstweekday(self):
        return self._firstweekday % 7

    def setfirstweekday(self, firstweekday):
        self._firstweekday = firstweekday

    firstweekday = property(getfirstweekday, setfirstweekday)

    def iterweekdays(self):
        fw = self.firstweekday
        for i in range(fw, fw + 7):
            yield i % 7

    def itermonthdays3(self, year, month):
        day1, ndays = monthrange(year, month)
        fw = self.firstweekday
        before = (day1 - fw) % 7
        after = (fw - day1 - ndays) % 7
        py, pm = (year - 1, 12) if month == 1 else (year, month - 1)
        end = _monthlen(py, pm) + 1
        for d in range(end - before, end):
            yield py, pm, d
        for d in range(1, ndays + 1):
            yield year, month, d
        ny, nm = (year + 1, 1) if month == 12 else (year, month + 1)
        for d in range(1, after + 1):
            yield ny, nm, d

    def itermonthdays4(self, year, month):
        fw = self.firstweekday
        for i, (y, m, d) in enumerate(self.itermonthdays3(year, month)):
            yield y, m, d, (fw + i) % 7

    def itermonthdates(self, year, month):
        for y, m, d in self.itermonthdays3(year, month):
            yield datetime.date(y, m, d)

    def itermonthdays(self, year, month):
        day1, ndays = monthrange(year, month)
        fw = self.firstweekday
        for _ in range((day1 - fw) % 7):
            yield 0
        yield from range(1, ndays + 1)
        for _ in range((fw - day1 - ndays) % 7):
            yield 0

    def itermonthdays2(self, year, month):
        for i, d in enumerate(self.itermonthdays(year, month), self.firstweekday):
            yield d, i % 7

    def monthdatescalendar(self, year, month):
        return _chunks(list(self.itermonthdates(year, month)), 7)

    def monthdays2calendar(self, year, month):
        return _chunks(list(self.itermonthdays2(year, month)), 7)

    def monthdayscalendar(self, year, month):
        return _chunks(list(self.itermonthdays(year, month)), 7)

    def yeardatescalendar(self, year, width=3):
        return _chunks([self.monthdatescalendar(year, m) for m in range(1, 13)],
                       width)

    def yeardays2calendar(self, year, width=3):
        return _chunks([self.monthdays2calendar(year, m) for m in range(1, 13)],
                       width)

    def yeardayscalendar(self, year, width=3):
        return _chunks([self.monthdayscalendar(year, m) for m in range(1, 13)],
                       width)


def _join_cols(cols, colwidth, spacing):
    return (" " * spacing).join(c.center(colwidth) for c in cols)


class TextCalendar(Calendar):
    def formatday(self, day, weekday, width):
        s = "" if day == 0 else "%2i" % day
        return s.center(width)

    def formatweek(self, theweek, width):
        return " ".join(self.formatday(d, wd, width) for d, wd in theweek)

    def formatweekday(self, day, width):
        names = day_name if width >= 9 else day_abbr
        return names[day][:width].center(width)

    def formatweekheader(self, width):
        return " ".join(self.formatweekday(i, width) for i in self.iterweekdays())

    def formatmonthname(self, theyear, themonth, width, withyear=True):
        if not 1 <= themonth <= 12:
            raise IllegalMonthError(themonth)
        s = month_name[themonth]
        if withyear:
            s = "%s %r" % (s, theyear)
        return s.center(width)

    def formatmonth(self, theyear, themonth, w=0, l=0):
        w = max(2, w)
        l = max(1, l)
        s = self.formatmonthname(theyear, themonth, 7 * (w + 1) - 1).rstrip()
        s += "\n" * l
        s += self.formatweekheader(w).rstrip()
        s += "\n" * l
        for week in self.monthdays2calendar(theyear, themonth):
            s += self.formatweek(week, w).rstrip()
            s += "\n" * l
        return s

    def formatyear(self, theyear, w=2, l=1, c=6, m=3):
        w = max(2, w)
        l = max(1, l)
        c = max(2, c)
        colwidth = (w + 1) * 7 - 1
        v = [repr(theyear).center(colwidth * m + c * (m - 1)).rstrip(), "\n" * l]
        header = self.formatweekheader(w)
        for i, row in enumerate(self.yeardays2calendar(theyear, m)):
            months = range(m * i + 1, min(m * (i + 1) + 1, 13))
            v.append("\n" * l)
            names = [self.formatmonthname(theyear, k, colwidth, False)
                     for k in months]
            v.append(_join_cols(names, colwidth, c).rstrip())
            v.append("\n" * l)
            v.append(_join_cols([header for _ in months], colwidth, c).rstrip())
            v.append("\n" * l)
            height = max(len(cal) for cal in row)
            for j in range(height):
                weeks = [self.formatweek(cal[j], w) if j < len(cal) else ""
                         for cal in row]
                v.append(_join_cols(weeks, colwidth, c).rstrip())
                v.append("\n" * l)
        return "".join(v)


_c = TextCalendar()


def firstweekday():
    return _c.getfirstweekday()


def setfirstweekday(firstweekday):
    if not MONDAY <= firstweekday <= SUNDAY:
        raise IllegalWeekdayError(firstweekday)
    _c.firstweekday = firstweekday


def monthcalendar(year, month):
    return _c.monthdayscalendar(year, month)


def weekheader(width):
    return _c.formatweekheader(width)


def month(theyear, themonth, w=0, l=0):
    return _c.formatmonth(theyear, themonth, w, l)


def calendar(theyear, w=2, l=1, c=6, m=3):
    return _c.formatyear(theyear, w, l, c, m)


_EPOCH_ORD = datetime.date(1970, 1, 1).toordinal()


def timegm(tuple):
    year, month, day, hour, minute, second = tuple[:6]
    days = datetime.date(year, month, 1).toordinal() - _EPOCH_ORD + day - 1
    return ((days * 24 + hour) * 60 + minute) * 60 + second
