"""minisql: an in-memory SQL engine. See SPEC.md."""


class Error(Exception):
    """Raised for every invalid statement."""


class Database:
    def execute(self, sql):
        raise Error("not implemented")


def connect():
    return Database()
