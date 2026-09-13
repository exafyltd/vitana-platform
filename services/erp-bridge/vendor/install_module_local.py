#!/usr/bin/env python3
"""Install a vendored ERPClaw expansion module from a LOCAL directory — no network.

Mirrors module_manager.install_module() step for step (registry manifest
integrity check, copy, erpclaw_module row, init_db.py, module migrations,
action cache) but takes the module tree from disk instead of `git clone`,
so the bridge image can ship a pinned copy and production never reaches
GitHub. Dialect-aware (module_manager's own cache builder uses SQLite-only
`INSERT OR REPLACE`).
"""
import hashlib, json, os, shutil, subprocess, sys, uuid
from datetime import datetime, timezone

ERPCLAW_ROOT = os.environ["ERPCLAW_ROOT"]           # pinned foundation checkout
MODULE_NAME = sys.argv[1]                           # e.g. erpclaw-growth
SOURCE_DIR = sys.argv[2]                            # local pinned addon subdir
sys.path.insert(0, os.path.join(ERPCLAW_ROOT, "scripts"))
sys.path.insert(0, os.path.join(ERPCLAW_ROOT, "scripts", "erpclaw-setup", "lib"))
import module_manager as mm                          # noqa: E402
from erpclaw_lib.db import get_connection            # noqa: E402
from erpclaw_lib.paths import modules_dir, lib_dir   # noqa: E402

registry = json.load(open(os.path.join(ERPCLAW_ROOT, "scripts", "module_registry.json")))
info = registry["modules"][MODULE_NAME]
install_path = os.path.join(modules_dir(), MODULE_NAME)
os.makedirs(modules_dir(), exist_ok=True)
if os.path.isdir(install_path):
    shutil.rmtree(install_path)
shutil.copytree(SOURCE_DIR, install_path)

# 1. integrity: the vendored tree must match the signed registry manifest
from erpclaw_lib.skip_filters import SKIP_DIRS, SKIP_SUFFIXES, SKIP_FILE_EXACT  # noqa: E402
manifest = info.get("files_sha256") or {}
delivered = set()
for root, dirs, files in os.walk(install_path):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        if f in SKIP_FILE_EXACT or any(f.endswith(s) for s in SKIP_SUFFIXES):
            continue
        delivered.add(os.path.relpath(os.path.join(root, f), install_path))
expected = set(manifest)
mismatched = [r for r in sorted(expected & delivered)
              if hashlib.sha256(open(os.path.join(install_path, r), "rb").read()).hexdigest() != manifest[r]]
missing, extra = sorted(expected - delivered), sorted(delivered - expected)
print(json.dumps({"integrity": {"expected": len(expected), "delivered": len(delivered),
                                "missing": missing, "extra": extra, "mismatched": mismatched}}))
if missing or extra or mismatched:
    shutil.rmtree(install_path, ignore_errors=True)
    sys.exit("integrity check failed — vendored tree != signed registry manifest")

# 2. erpclaw_module row
conn = get_connection()
now = datetime.now(timezone.utc).isoformat(timespec="seconds")
conn.execute("DELETE FROM erpclaw_module_action WHERE module_name = ?", (MODULE_NAME,))
conn.execute("DELETE FROM erpclaw_module WHERE name = ?", (MODULE_NAME,))
conn.execute(
    """INSERT INTO erpclaw_module (id, name, display_name, version, category, github_repo,
       install_path, installed_at, updated_at, install_status, requires_json, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'updating', ?, 1)""",
    (str(uuid.uuid4()), MODULE_NAME, info["display_name"], info["version"], info["category"],
     info["github"], install_path, now, now, json.dumps(info.get("requires", []))))
conn.commit()

# 3. init_db.py (CREATE TABLE IF NOT EXISTS, dialect-aware via erpclaw_lib.seam)
env = dict(os.environ); env["PYTHONPATH"] = lib_dir() + os.pathsep + env.get("PYTHONPATH", "")
r = subprocess.run([sys.executable, os.path.join(install_path, "init_db.py")],
                   capture_output=True, text=True, timeout=120, env=env)
print("init_db.py rc", r.returncode, (r.stderr or r.stdout).strip()[-400:])
if r.returncode != 0:
    sys.exit("init_db failed")

# 4. module migrations through the foundation runner (ledger rows under the module name)
applied = mm._run_module_migrations(MODULE_NAME, install_path)
print("module migrations applied:", applied)

# 5. action cache — dialect-safe re-implementation of build_action_cache
actions = mm._extract_actions_via_ast(os.path.join(install_path, "scripts", "db_query.py")) \
    or mm._extract_actions_via_regex(os.path.join(install_path, "scripts", "db_query.py"))
for sub in os.listdir(os.path.join(install_path, "scripts")):
    p = os.path.join(install_path, "scripts", sub, "db_query.py")
    if os.path.isfile(p):
        actions |= (mm._extract_actions_via_ast(p) or mm._extract_actions_via_regex(p))
conn.executemany("INSERT INTO erpclaw_module_action (module_name, action_name) VALUES (?, ?)",
                 [(MODULE_NAME, a) for a in sorted(actions)])
conn.execute("UPDATE erpclaw_module SET install_status='installed', action_count=?, updated_at=? WHERE name=?",
             (len(actions), now, MODULE_NAME))
conn.commit()
print(json.dumps({"module": MODULE_NAME, "version": info["version"], "actions_cached": len(actions),
                  "install_path": install_path}))
