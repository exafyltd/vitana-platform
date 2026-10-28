#!/usr/bin/env python3
"""Re-stamp RepoWise's stored config fingerprint after `repowise init` (VTID-04758).

`repowise init --no-claude-md --no-agents` records `config_fingerprint` in
.repowise/state.json BEFORE it writes the `editor_files` settings into
config.yaml. The first `repowise update` afterwards therefore sees a "config
change" and re-renders every page (measured on vitana-platform: 6703 pages,
~14 min) although nothing changed. A later update re-stamps it, so this only
ever bit the first update after an init: exactly the one a session runs on a
fresh CI seed.

This writes the fingerprints RepoWise itself computes for the config as it now
is, using RepoWise's own functions, so the next update compares like with like.
Run it with the Python that has repowise installed. Usage: <repo_dir>
"""
import json
import sys
from pathlib import Path

from repowise.cli.helpers import config_fingerprint, load_config
from repowise.core.repo_config import config_dependency_fingerprints

repo = Path(sys.argv[1]).resolve()
state_path = repo / ".repowise" / "state.json"
state = json.loads(state_path.read_text())
before = state.get("config_fingerprint")
state["config_fingerprint"] = config_fingerprint(repo)
state["config_dependency_fingerprints"] = config_dependency_fingerprints(repo, config=load_config(repo))
state_path.write_text(json.dumps(state, indent=2))
print(f"config fingerprint {'unchanged' if before == state['config_fingerprint'] else 're-stamped'}")
