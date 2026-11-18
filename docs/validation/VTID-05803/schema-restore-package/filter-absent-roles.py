#!/usr/bin/env python3
"""VTID-05803: drop dump statements that name a role absent on the staging target (Kiro 1 semantics, fail closed).
Usage: filter-absent-roles.py <dump.sql> <present-roles.txt> <out.sql> <excluded.log>
- POLICY entries whose TO list names an absent role: PERMISSIVE -> excluded and logged; RESTRICTIVE -> exit 4
  (leaving it out would widen access), nothing written.
- ACL / DEFAULT ACL statements (GRANT, REVOKE, ALTER DEFAULT PRIVILEGES) that name an absent role: excluded and logged.
Works on pg_dump's TOC blocks ("-- Name: ...; Type: X; ..."), never on statement text inside function bodies.
Exit 0 ok, 4 restrictive policy for an absent role, 2 bad input."""
import re, sys

dump, roles_f, out_f, log_f = sys.argv[1:5]
present = {l.strip() for l in open(roles_f) if l.strip()} | {"public", "PUBLIC"}
lines = open(dump, encoding="utf-8").read().split("\n")
hdr = re.compile(r"^-- Name: (.*?); Type: ([A-Z ]+); Schema: ([^;]*);")

# Split into blocks at TOC headers ("--" line, "-- Name: ..." line).
starts = [i - 1 for i, l in enumerate(lines) if hdr.match(l) and i > 0 and lines[i - 1] == "--"]
if not starts:
    print("no pg_dump TOC headers found", file=sys.stderr); sys.exit(2)
blocks = [lines[:starts[0]]] + [lines[a:b] for a, b in zip(starts, starts[1:] + [len(lines)])]

def roles_in(text, kind):
    if kind == "POLICY":
        m = re.search(r"\bTO\s+(.+?)(?:\s+USING\b|\s+WITH CHECK\b|;)", text, re.S)
        return [r.strip().strip('"') for r in m.group(1).split(",")] if m else []
    found = []
    for m in re.finditer(r"\b(?:TO|FROM|FOR ROLE)\s+([^;]+?)(?:\s+(?:IN SCHEMA|GRANT|REVOKE|WITH GRANT OPTION|GRANTED BY)\b|;)", text):
        found += [r.strip().strip('"') for r in m.group(1).split(",")]
    return found

out, excl = [], []
for b in blocks:
    m = hdr.match(b[1]) if len(b) > 1 else None
    kind = m.group(2).strip() if m else None
    if kind == "POLICY":
        body = "\n".join(b)
        absent = [r for r in roles_in(body, "POLICY") if r not in present]
        if absent:
            if re.search(r"\bAS RESTRICTIVE\b", body):
                print(f"RESTRICTIVE policy {m.group(1)} names absent role(s) {','.join(absent)}: cannot be restored", file=sys.stderr)
                sys.exit(4)
            excl.append(f"policy|{m.group(1)}|permissive|absent role {','.join(absent)}")
            continue
    if kind in ("ACL", "DEFAULT ACL"):
        kept = []
        for l in b:
            if re.match(r"^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)\b", l):
                absent = [r for r in roles_in(l, "ACL") if r not in present]
                if absent:
                    excl.append(f"acl|{m.group(1)}|{l[:160]}|absent role {','.join(absent)}")
                    continue
            kept.append(l)
        b = kept
    out.extend(b)

open(out_f, "w", encoding="utf-8").write("\n".join(out))
open(log_f, "w").write("\n".join(excl) + ("\n" if excl else ""))
print(f"absent-role filter: excluded {sum(1 for e in excl if e.startswith('policy|'))} permissive policies, "
      f"{sum(1 for e in excl if e.startswith('acl|'))} grant statements; 0 restrictive")
