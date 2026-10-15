"""toolkit.cal: calendar computations and plain-text calendars compatible
with the standard library's `calendar` module for the subset in
spec/cal.md.

This is a stub.  Every public name exists so imports succeed; replace the
bodies and give the constants and name sequences their real values.  Do
not import calendar or any other blocked module (datetime is allowed).
"""

# TODO: the weekday constants (0 = Monday .. 6 = Sunday).
MONDAY = TUESDAY = WEDNESDAY = THURSDAY = FRIDAY = SATURDAY = SUNDAY = None

# TODO: read-only sequences of English names (see the spec).
day_name = day_abbr = month_name = month_abbr = None


class IllegalMonthError(ValueError, IndexError):
    def __init__(self, month):
        self.month = month


class IllegalWeekdayError(ValueError):
    def __init__(self, weekday):
        self.weekday = weekday


def isleap(year):
    raise NotImplementedError("toolkit.cal.isleap")


def leapdays(y1, y2):
    raise NotImplementedError("toolkit.cal.leapdays")


def weekday(year, month, day):
    raise NotImplementedError("toolkit.cal.weekday")


def monthrange(year, month):
    raise NotImplementedError("toolkit.cal.monthrange")


def timegm(tuple):
    raise NotImplementedError("toolkit.cal.timegm")


def firstweekday():
    raise NotImplementedError("toolkit.cal.firstweekday")


def setfirstweekday(firstweekday):
    raise NotImplementedError("toolkit.cal.setfirstweekday")


def monthcalendar(year, month):
    raise NotImplementedError("toolkit.cal.monthcalendar")


def weekheader(width):
    raise NotImplementedError("toolkit.cal.weekheader")


def month(theyear, themonth, w=0, l=0):
    raise NotImplementedError("toolkit.cal.month")


def calendar(theyear, w=2, l=1, c=6, m=3):
    raise NotImplementedError("toolkit.cal.calendar")


class Calendar:
    def __init__(self, firstweekday=0):
        raise NotImplementedError("toolkit.cal.Calendar")

    def getfirstweekday(self):
        raise NotImplementedError

    def setfirstweekday(self, firstweekday):
        raise NotImplementedError

    def iterweekdays(self):
        raise NotImplementedError

    def itermonthdates(self, year, month):
        raise NotImplementedError

    def itermonthdays(self, year, month):
        raise NotImplementedError

    def itermonthdays2(self, year, month):
        raise NotImplementedError

    def itermonthdays3(self, year, month):
        raise NotImplementedError

    def itermonthdays4(self, year, month):
        raise NotImplementedError

    def monthdatescalendar(self, year, month):
        raise NotImplementedError

    def monthdays2calendar(self, year, month):
        raise NotImplementedError

    def monthdayscalendar(self, year, month):
        raise NotImplementedError

    def yeardatescalendar(self, year, width=3):
        raise NotImplementedError


class TextCalendar(Calendar):
    def formatweekheader(self, width):
        raise NotImplementedError

    def formatmonth(self, theyear, themonth, w=0, l=0):
        raise NotImplementedError

    def formatyear(self, theyear, w=2, l=1, c=6, m=3):
        raise NotImplementedError
