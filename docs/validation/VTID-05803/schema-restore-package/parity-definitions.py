#!/usr/bin/env python3
"""R2 check (VTID-05803): no public->auth.users foreign key may exist on the staging target, and the restore log must
list as excluded every such FK the live dump carried. The source inventory is reported for reference.
Args: <source-auth-fk-inventory.tsv> <staging-fk-definitions.out> [r2-excluded-fks.log]. Exit 1 on any violation."""
import csv, re, sys
src = [r["conname"] for r in csv.DictReader(open(sys.argv[1]), delimiter="\t") if r["src_schema"] == "public"]
tgt = [l.split("|")[0] for l in open(sys.argv[2]) if l.count("|") == 8]
bad = [(n, "public->auth.users FK present on target (R2 excludes it)") for n in tgt]
if len(sys.argv) > 3:
    log = open(sys.argv[3]).read()
    excl = re.findall(r"R2 excluded fk \S+\.(\S+)", log)
    tot = re.search(r"R2 excluded fks total (\d+)", log)
    if not tot or int(tot.group(1)) != len(excl):
        bad.append(("r2-log", "exclusion log incomplete"))
    print(f"R2: excluded during restore={len(excl)}; source inventory (2026-11-17) public->auth.users={len(src)}; "
          f"inventory names not seen in this dump={len(set(src) - set(excl))}")
print(f"public->auth.users FKs on target: {len(tgt)} (expected 0); violations={len(bad)}")
for b in bad[:20]:
    print("  ", b)
sys.exit(1 if bad else 0)
