#!/usr/bin/env python3
# VTID-05803 apply-time safety guard for the schema correction.
#
# usage: guard-correction.py <correction.sql>  -> exit 0 if safe to apply, 2 if it would execute anything destructive
# or data-modifying AT APPLY TIME.
#
# The correction is schema-additive. At apply time psql executes only TOP-LEVEL statements; the bodies of
# CREATE [OR REPLACE] FUNCTION are DEFINED, not executed, so DML inside a function body (INSERT/UPDATE/DELETE as part of
# the function's own logic) is fine and must NOT trip the guard. This guard therefore strips dollar-quoted blocks
# (function/anonymous bodies) before scanning, then refuses if any TOP-LEVEL statement is destructive or data-modifying
# (DROP/TRUNCATE/DELETE/REVOKE/INSERT/UPDATE/MERGE/COPY/ALTER ... DROP <object>) or is an anonymous DO block (which WOULD
# execute its body at apply time, and the additive generator never emits one).
import re, sys

if len(sys.argv) != 2:
    sys.stderr.write("usage: guard-correction.py <file>\n"); sys.exit(2)
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()

# Remove dollar-quoted blocks ($tag$ ... $tag$), including nested-safe simple case, so function/DO bodies are ignored.
stripped = re.sub(r"\$([A-Za-z0-9_]*)\$.*?\$\1\$", " ", text, flags=re.S)
# Also remove single-quoted string literals and -- line comments so keywords inside them don't trip the scan.
stripped = re.sub(r"--[^\n]*", " ", stripped)
stripped = re.sub(r"'(?:[^']|'')*'", " ", stripped)

destructive = re.compile(
    r"(?im)(?:^|;)\s*(drop|truncate|delete|revoke|insert|update|merge|copy|do)\b"
    r"|\bdrop\s+(table|schema|index|function|constraint|policy|type|sequence|view|trigger|column|role|owned|database|materialized)\b"
)
m = destructive.search(stripped)
if m:
    # Show the offending top-level fragment (never the function bodies we stripped).
    i = max(0, m.start() - 20)
    frag = stripped[i:m.start() + 60].replace("\n", " ")
    sys.stderr.write("REFUSED: correction.sql has a top-level destructive/data-modifying statement: ...%s...\n" % frag)
    sys.exit(2)
print("guard: additive-only (no top-level destructive/DML statement); safe to apply")
sys.exit(0)
