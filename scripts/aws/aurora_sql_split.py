#!/usr/bin/env python3
"""Split a multi-statement Postgres migration file into single statements
(VTID-05023 part 8).

The RDS Data API runs exactly ONE statement per call, so
scripts/aws/aurora-apply-migration.sh needs the file cut the way psql cuts it.
The lexer follows psql's own (src/fe_utils/psqlscan.l):

  * `--` line comments and nested `/* */` block comments;
  * single-quoted strings ('' escape), E'...' strings (backslash escapes too),
    double-quoted identifiers ("" escape);
  * dollar-quoted bodies with any tag ($$, $fn$, $body$ ...), never confused
    with a `$1` parameter or a `$` inside an identifier;
  * a `;` ends a statement only outside all of the above, at parenthesis
    depth 0 and outside a `CREATE [OR REPLACE] FUNCTION|PROCEDURE ... BEGIN
    ATOMIC ... END` body (psql's begin_depth heuristic, CASE ... END included).

Each statement is classified:

  * transaction control (BEGIN / START TRANSACTION / COMMIT / END) is dropped:
    the runner owns the transaction. ROLLBACK / ABORT is a hard error, not
    dropped: a file that rolls its own work back must never be committed by
    the runner (dropping it would turn "apply nothing" into "apply everything");
  * statements Postgres refuses inside a transaction block (CREATE / DROP
    INDEX CONCURRENTLY, REINDEX ... CONCURRENTLY, VACUUM, CREATE / DROP
    DATABASE, ALTER SYSTEM, ...) are flagged `transactional: false`.
    ALTER TYPE ... ADD VALUE is transactional (Aurora runs PG >= 12);
  * a psql meta-command (any backslash outside quotes and comments, e.g.
    `\\set ON_ERROR_STOP on`) is a hard error naming the line.

Usage:
  aurora_sql_split.py <file.sql> [--out plan.json]   -> JSON on stdout / file
Exit 0 on success, 1 with "ERROR: <file>:<line>: ..." on stderr otherwise.
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field

DOLLAR_DELIM = re.compile(r"\$([A-Za-z_\x80-\U0010ffff][A-Za-z_0-9\x80-\U0010ffff]*)?\$")


def _ident_start(c: str) -> bool:
    return c.isascii() and (c.isalpha() or c == "_") or not c.isascii()


def _ident_cont(c: str) -> bool:
    return _ident_start(c) or c.isdigit() or c == "$"


class SplitError(Exception):
    def __init__(self, line: int, message: str):
        super().__init__(f"line {line}: {message}")
        self.line = line
        self.message = message


@dataclass
class Statement:
    n: int
    line: int
    sql: str
    words: list = field(default_factory=list)
    transactional: bool = True
    kind: str = "sql"
    start: int = 0          # offset of the statement text in the file

    def as_json(self) -> dict:
        return {"n": self.n, "line": self.line, "sql": self.sql,
                "transactional": self.transactional, "kind": self.kind}


@dataclass
class SplitResult:
    statements: list
    dropped: list

    @property
    def non_transactional(self) -> list:
        return [s for s in self.statements if not s.transactional]

    def as_json(self, path: str | None = None) -> dict:
        return {
            "file": path,
            "statements": [s.as_json() for s in self.statements],
            "dropped": [{"line": d.line, "sql": d.sql, "reason": d.kind} for d in self.dropped],
            "counts": {"statements": len(self.statements),
                       "non_transactional": len(self.non_transactional),
                       "dropped": len(self.dropped)},
        }


def _classify(words: list) -> tuple[str, bool]:
    """Returns (kind, transactional). kind 'drop' = transaction control."""
    w = words + [""] * 4
    w0, w1 = w[0], w[1]
    if w0 in ("BEGIN",) or (w0 == "START" and w1 == "TRANSACTION"):
        return "drop", True
    if w0 in ("COMMIT", "END") and w1 != "PREPARED":
        return "drop", True
    if w0 in ("ROLLBACK", "ABORT") and w1 not in ("TO", "PREPARED"):
        return "rollback", True
    if w0 in ("COMMIT", "ROLLBACK") and w1 == "PREPARED":
        return "non_transactional", False
    if w0 == "CREATE":
        rest = w[1:]
        if rest[0] == "UNIQUE":
            rest = rest[1:]
        if rest[0] == "INDEX" and rest[1] == "CONCURRENTLY":
            return "non_transactional", False
        if rest[0] in ("DATABASE", "TABLESPACE", "SUBSCRIPTION"):
            return "non_transactional", False
    if w0 == "DROP":
        if w1 == "INDEX" and w[2] == "CONCURRENTLY":
            return "non_transactional", False
        if w1 in ("DATABASE", "TABLESPACE", "SUBSCRIPTION"):
            return "non_transactional", False
    if w0 == "REINDEX" and ("CONCURRENTLY" in words or "SYSTEM" in words or "DATABASE" in words):
        return "non_transactional", False
    if w0 == "VACUUM":
        return "non_transactional", False
    if w0 == "ALTER" and w1 == "SYSTEM":
        return "non_transactional", False
    if w0 == "CLUSTER" and len(words) == 1:
        return "non_transactional", False
    if w0 == "DISCARD" and w1 == "ALL":
        return "non_transactional", False
    return "sql", True


def split_sql(text: str) -> SplitResult:
    statements: list = []
    dropped: list = []
    n = len(text)
    i = 0
    line = 1

    # per-statement state
    start = None          # index of first significant char
    start_line = None
    words: list = []
    paren = 0
    begin_depth = 0
    ident_count = 0
    ident_first = ["", "", "", ""]

    def mark_start():
        nonlocal start, start_line
        if start is None:
            start, start_line = i, line

    def finish(end: int):
        nonlocal start, start_line, words, paren, begin_depth, ident_count, ident_first
        if start is not None and words is not None:
            sql = text[start:end].rstrip()
            if _has_content(sql):
                kind, tx = _classify(words)
                st = Statement(n=0, line=start_line, sql=sql, words=words, transactional=tx, kind=kind,
                               start=start)
                if kind == "rollback":
                    raise SplitError(start_line, "top-level ROLLBACK/ABORT: the file rolls back its own work; "
                                     "the runner would commit it instead, refusing")
                if kind == "drop":
                    st.kind = "transaction control (the runner manages the transaction)"
                    dropped.append(st)
                else:
                    st.n = len(statements) + 1
                    statements.append(st)
        start, start_line, words = None, None, []
        paren = begin_depth = ident_count = 0
        ident_first = ["", "", "", ""]

    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if c == "\n":
            line += 1
            i += 1
            continue
        if c.isspace():
            i += 1
            continue
        if c == "-" and nxt == "-":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and nxt == "*":
            mark_start()
            open_line = line
            depth, j = 1, i + 2
            while j < n and depth:
                if text.startswith("/*", j):
                    depth += 1
                    j += 2
                elif text.startswith("*/", j):
                    depth -= 1
                    j += 2
                else:
                    if text[j] == "\n":
                        line += 1
                    j += 1
            if depth:
                raise SplitError(open_line, "unterminated /* comment")
            i = j
            continue
        if c == "\\":
            raise SplitError(line, "psql meta-command (backslash) is not SQL and cannot run over the "
                             "RDS Data API: " + text[i:text.find("\n", i) if "\n" in text[i:] else n].strip()[:80])
        mark_start()
        if c == "'":
            i, line = _skip_string(text, i, line, backslash=False)
            continue
        if c == '"':
            open_line = line
            j = i + 1
            while True:
                k = text.find('"', j)
                if k < 0:
                    raise SplitError(open_line, 'unterminated quoted identifier')
                line += text.count("\n", j, k)
                if text.startswith('""', k):
                    j = k + 2
                    continue
                i = k + 1
                break
            continue
        if c == "$":
            m = DOLLAR_DELIM.match(text, i)
            if m:
                delim = m.group(0)
                k = text.find(delim, m.end())
                if k < 0:
                    raise SplitError(line, f"unterminated dollar-quoted string {delim}")
                line += text.count("\n", i, k)
                i = k + len(delim)
                continue
            j = i + 1
            while j < n and text[j].isdigit():
                j += 1
            i = j
            continue
        if _ident_start(c):
            j = i + 1
            while j < n and _ident_cont(text[j]):
                j += 1
            word = text[i:j]
            up = word.upper()
            if up == "E" and j < n and text[j] == "'":
                i, line = _skip_string(text, j, line, backslash=True)
                continue
            words.append(up)
            # psql's begin_depth heuristic (psqlscan.l, {identifier} rule)
            if ident_count < 4:
                ident_first[ident_count] = up[0] if up in ("CREATE", "FUNCTION", "PROCEDURE", "OR", "REPLACE") else ""
            ident_count += 1
            f = ident_first
            if f[0] == "C" and (f[1] in ("F", "P") or (f[1] == "O" and f[2] == "R" and f[3] in ("F", "P"))) \
                    and paren == 0:
                if up == "BEGIN":
                    begin_depth += 1
                elif up == "CASE":
                    if begin_depth >= 1:
                        begin_depth += 1
                elif up == "END":
                    if begin_depth > 0:
                        begin_depth -= 1
            i = j
            continue
        if c.isdigit():
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] in "._"):
                j += 1
            i = j
            continue
        if c == "(":
            paren += 1
        elif c == ")":
            paren = max(0, paren - 1)
        elif c == ";" and paren == 0 and begin_depth == 0:
            finish(i)
            i += 1
            continue
        i += 1
    finish(n)
    return SplitResult(statements=statements, dropped=dropped)


def _skip_string(text: str, i: int, line: int, backslash: bool) -> tuple[int, int]:
    """i points at the opening quote. Returns (index after closing quote, line)."""
    open_line = line
    n = len(text)
    j = i + 1
    while j < n:
        c = text[j]
        if c == "\n":
            line += 1
        if backslash and c == "\\":
            if j + 1 < n and text[j + 1] == "\n":
                line += 1
            j += 2
            continue
        if c == "'":
            if j + 1 < n and text[j + 1] == "'":
                j += 2
                continue
            return j + 1, line
        j += 1
    raise SplitError(open_line, "unterminated quoted string")


def _has_content(sql: str) -> bool:
    """True when the text has anything besides whitespace and comments."""
    s = re.sub(r"--[^\n]*", "", sql)
    # block comments may nest; strip innermost repeatedly
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"/\*(?:(?!/\*|\*/).)*\*/", "", s, flags=re.S)
    return bool(s.strip())


def main(argv: list) -> int:
    args = list(argv)
    out = None
    if "--out" in args:
        k = args.index("--out")
        out = args[k + 1]
        del args[k:k + 2]
    if len(args) != 1:
        print("usage: aurora_sql_split.py <file.sql> [--out plan.json]", file=sys.stderr)
        return 2
    path = args[0]
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        result = split_sql(text)
    except SplitError as e:
        print(f"ERROR: {path}:{e.line}: {e.message}", file=sys.stderr)
        return 1
    except (OSError, UnicodeDecodeError) as e:
        print(f"ERROR: {path}: {e}", file=sys.stderr)
        return 1
    doc = json.dumps(result.as_json(path), indent=1, ensure_ascii=False)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(doc + "\n")
    else:
        print(doc)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
