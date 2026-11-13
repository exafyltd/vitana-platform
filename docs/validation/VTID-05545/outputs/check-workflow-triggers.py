#!/usr/bin/env python3
"""Cross-check of scripts/eng/github-workflows.json against PyYAML (an independent YAML parser).

The list records, for each of the 159 workflow files, its triggers and whether a push to main starts it. The test
scripts/eng/github-workflows.test.mjs re-reads the files with a small `on:` reader of its own; this script reads them with PyYAML
and compares, so the reader and the list are checked by a second implementation.

usage: PYTHONPATH=<dir with PyYAML> python3 check-workflow-triggers.py <platform .github/workflows> <vitana-v1 .github/workflows> <github-workflows.json>
"""
import json
import os
import sys

import yaml

platform_dir, v1_dir, list_file = sys.argv[1:4]
doc = json.load(open(list_file, encoding="utf-8"))


def on_of(path):
    y = yaml.safe_load(open(path, encoding="utf-8"))
    on = y.get(True, y.get("on"))      # YAML 1.1 reads the key `on` as the boolean True
    if isinstance(on, str):
        return {on: None}
    if isinstance(on, list):
        return {k: None for k in on}
    return on if isinstance(on, dict) else {}


def matches_main(branches):
    return not branches or any(p in ("main", "**", "*") for p in branches)


problems = []
seen = 0
for repo, d in (("vitana-platform", platform_dir), ("vitana-v1", v1_dir)):
    listed = doc["repositories"][repo]["workflows"]
    files = sorted(f for f in os.listdir(d) if f.endswith((".yml", ".yaml")))
    for f in sorted(set(files) - set(listed)):
        problems.append("%s/%s: on disk, not in the list" % (repo, f))
    for f in sorted(set(listed) - set(files)):
        problems.append("%s/%s: in the list, not on disk" % (repo, f))
    for f in files:
        if f not in listed:
            continue
        seen += 1
        on = on_of(os.path.join(d, f))
        triggers = sorted(on.keys())
        push = on.get("push")
        push_main = "push" in on and matches_main(push.get("branches") if isinstance(push, dict) else None)
        e = listed[f]
        if "triggers" in e and e["triggers"] != triggers:
            problems.append("%s/%s: triggers %s in the list, %s in the file" % (repo, f, e["triggers"], triggers))
        if "push_main" in e and e["push_main"] != push_main:
            problems.append("%s/%s: push_main %s in the list, %s in the file" % (repo, f, e["push_main"], push_main))
        if e.get("action") == "keep" and push_main and e.get("main_push") == "none":
            problems.append("%s/%s: kept, starts on a push to main, but main_push says none" % (repo, f))

print("files compared with PyYAML: %d (platform %d, vitana-v1 %d)" % (seen, len(os.listdir(platform_dir)), len(os.listdir(v1_dir))))
for p in problems:
    print("DIFFERENCE", p)
print("differences: %d" % len(problems))
sys.exit(1 if problems else 0)
