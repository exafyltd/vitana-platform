#!/usr/bin/env python3
"""Definition-level parity: every public->auth.users foreign key in the source inventory must exist on the target
with the same definition, referential actions, match type, validation and deferrability. Exit 1 on any difference."""
import csv, sys

def norm(v):
    return {"t": "true", "f": "false"}.get(str(v).strip().lower(), str(v).strip().lower())

src = {r["conname"]: r for r in csv.DictReader(open(sys.argv[1]), delimiter="\t") if r["src_schema"] == "public"}
tgt = {}
for line in open(sys.argv[2]):
    f = line.rstrip("\n").split("|")
    if len(f) == 9:
        tgt[f[0]] = f

bad = []
for name, r in src.items():
    f = tgt.get(name)
    if f is None:
        bad.append((name, "missing on target")); continue
    checks = {"table": (r["src_table"], f[1].split(".")[-1]), "def": (r["def"], f[2]),
              "confupdtype": (r["confupdtype"], f[3]), "confdeltype": (r["confdeltype"], f[4]),
              "confmatchtype": (r["confmatchtype"], f[5]), "convalidated": (norm(r["convalidated"]), norm(f[6])),
              "condeferrable": (norm(r["condeferrable"]), norm(f[7])), "condeferred": (norm(r["condeferred"]), norm(f[8]))}
    for k, (a, b) in checks.items():
        if norm(a) != norm(b):
            bad.append((name, f"{k}: source={a!r} target={b!r}"))
extra = sorted(set(tgt) - set(src))
for e in extra:
    bad.append((e, "extra on target"))
print(f"public->auth.users FKs: source={len(src)} target={len(tgt)} mismatches={len(bad)}")
for b in bad[:20]:
    print("  ", b)
sys.exit(1 if bad else 0)
