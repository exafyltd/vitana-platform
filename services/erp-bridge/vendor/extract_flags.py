#!/usr/bin/env python3
"""Generate vendor/action-flags.json from the pinned ERPClaw trees (VTID-03840).

For every domain script (foundation `scripts/erpclaw-*/db_query.py` and the
allowlisted expansion module's `scripts/*/db_query.py`) record the argparse
flags it declares and the actions it serves. The bridge runner only ever
passes a parameter whose flag appears here AND in the catalog's per-action
allowlist, so a model or a client cannot smuggle an undeclared CLI flag.

Regenerate whenever the pin moves:
    python3 vendor/extract_flags.py <ERPCLAW_ROOT> <ADDON_MODULE_DIR> > vendor/action-flags.json
"""
import json
import os
import re
import sys

FLAG_RE = re.compile(r'add_argument\(\s*"(--[a-z0-9\-]+)"([^)]*)\)', re.S)
ACTION_KEY_RE = re.compile(r'^\s*"([a-z0-9\-]+)"\s*:\s*[a-zA-Z_]', re.M)
ROUTER_MAP_RE = re.compile(r'^\s*"([a-z0-9\-]+)"\s*:\s*"([a-z0-9\-]+)"', re.M)


def scan_domain(path: str) -> dict:
    src = open(path, encoding="utf-8").read()
    flags: dict[str, dict] = {}
    for name, rest in FLAG_RE.findall(src):
        store_true = 'action="store_true"' in rest or "action='store_true'" in rest
        prev = flags.get(name)
        flags[name] = {"store_true": bool(store_true or (prev and prev["store_true"]))}
    flags = dict(sorted(flags.items()))
    m = re.search(r"\nACTIONS\s*=\s*\{(.*?)\n\}", src, re.S)
    actions = sorted(set(ACTION_KEY_RE.findall(m.group(1)))) if m else []
    return {"flags": flags, "actions": actions}


def scan_router(path: str) -> dict:
    src = open(path, encoding="utf-8").read()
    m = re.search(r"\nACTION_MAP\s*=\s*\{(.*?)\n\}", src, re.S)
    return dict(ROUTER_MAP_RE.findall(m.group(1))) if m else {}


def main(root: str, module_dir: str | None) -> dict:
    out = {"foundation": {"router": scan_router(os.path.join(root, "scripts", "db_query.py")), "domains": {}},
           "modules": {}}
    scripts = os.path.join(root, "scripts")
    for d in sorted(os.listdir(scripts)):
        p = os.path.join(scripts, d, "db_query.py")
        if d.startswith("erpclaw-") and os.path.isfile(p):
            out["foundation"]["domains"][d] = scan_domain(p)
    if module_dir:
        name = os.path.basename(module_dir.rstrip("/"))
        mod = {"router": scan_router(os.path.join(module_dir, "scripts", "db_query.py")), "domains": {}}
        ms = os.path.join(module_dir, "scripts")
        for d in sorted(os.listdir(ms)):
            p = os.path.join(ms, d, "db_query.py")
            if os.path.isfile(p):
                mod["domains"][d] = scan_domain(p)
        out["modules"][name] = mod
    return out


if __name__ == "__main__":
    root = sys.argv[1]
    module_dir = sys.argv[2] if len(sys.argv) > 2 else None
    json.dump(main(root, module_dir), sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")
