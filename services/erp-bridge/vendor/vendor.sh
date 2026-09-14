#!/usr/bin/env bash
# VTID-03840 — materialise the pinned ERPClaw foundation + allowlisted module
# into $ERPCLAW_ROOT / $ERPCLAW_HOME. Runs at image build. Never at runtime.
#
#   ERPCLAW_ROOT   where the foundation checkout lands (router: scripts/db_query.py)
#   ERPCLAW_HOME   install home (lib/, modules/, install-state markers)
#
# Guarantees:
#   * the checked-out commit == lock commit, or the build fails
#   * the Vitana patches apply cleanly (git apply --check first)
#   * the on-demand GitHub install path is disabled: `.no_autosync` marker
#     + the module tree is copied from the pinned addons checkout, never
#     cloned by module_manager at runtime (see install_module_local.py)
#   * no .git directories survive into the image
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/erpclaw.lock.json"
: "${ERPCLAW_ROOT:?set ERPCLAW_ROOT}"
: "${ERPCLAW_HOME:?set ERPCLAW_HOME}"
j() { python3 -c "import json,sys; d=json.load(open('$LOCK')); print(eval(sys.argv[1]))" "$1"; }
F_REPO=$(j "d['foundation']['repo']"); F_SHA=$(j "d['foundation']['commit']")
A_REPO=$(j "d['addons']['repo']");     A_SHA=$(j "d['addons']['commit']")

clone_pinned() { # repo sha dest
  rm -rf "$3"; git init -q "$3"
  git -C "$3" remote add origin "$1"
  git -C "$3" fetch -q --depth 1 origin "$2"
  git -C "$3" checkout -q FETCH_HEAD
  local got; got=$(git -C "$3" rev-parse HEAD)
  [ "$got" = "$2" ] || { echo "PIN MISMATCH for $1: got $got want $2" >&2; exit 1; }
}

echo "== foundation $F_SHA"
clone_pinned "$F_REPO" "$F_SHA" "$ERPCLAW_ROOT"
for p in $(j "' '.join(d['patches'])"); do
  git -C "$ERPCLAW_ROOT" apply --check "$HERE/$p"
  git -C "$ERPCLAW_ROOT" apply "$HERE/$p"
  echo "   applied $p"
done
# overlay: non-shipped CoA templates
python3 - "$LOCK" "$HERE" "$ERPCLAW_ROOT" <<'PY'
import json, shutil, sys, os
lock, here, root = sys.argv[1:]
for src, dst in json.load(open(lock))["overlay"].items():
    os.makedirs(os.path.dirname(os.path.join(root, dst)), exist_ok=True)
    shutil.copy(os.path.join(here, src), os.path.join(root, dst)); print("   overlay", dst)
PY

echo "== install home $ERPCLAW_HOME"
mkdir -p "$ERPCLAW_HOME/modules"
rm -rf "$ERPCLAW_HOME/lib"; cp -r "$ERPCLAW_ROOT/scripts/erpclaw-setup/lib" "$ERPCLAW_HOME/lib"
touch "$ERPCLAW_HOME/.no_autosync"   # module_manager: never sync the registry from GitHub

echo "== addons $A_SHA (module trees staged for install_module_local.py at first DB init)"
ADDONS_TMP="$(mktemp -d)"
clone_pinned "$A_REPO" "$A_SHA" "$ADDONS_TMP"
mkdir -p "$ERPCLAW_HOME/vendored-modules"
for sub in $(j "' '.join(m['subdir'] for m in d['addons']['modules'])"); do
  rm -rf "$ERPCLAW_HOME/vendored-modules/$sub"; cp -r "$ADDONS_TMP/$sub" "$ERPCLAW_HOME/vendored-modules/$sub"
  echo "   staged $sub"
done
rm -rf "$ADDONS_TMP" "$ERPCLAW_ROOT/.git"
find "$ERPCLAW_ROOT" "$ERPCLAW_HOME" -name "*.pyc" -delete
echo "== done"
