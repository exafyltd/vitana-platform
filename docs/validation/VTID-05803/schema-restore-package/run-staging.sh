#!/bin/sh
# VTID-05803 staging run wrapper. Deliberately NOT "set -e": every step records its own exit code so that a failure
# still produces the logs. Run from the package directory of the checked-out commit.
# Inputs (environment, set by the task override): EXPECTED_SHA (full commit SHA of the package).
# Credentials come from the task's secrets (PGUSER, PGPASSWORD); this script never prints them.
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || { echo "WRAPPER_FAIL: cannot enter package"; exit 20; }
echo "WRAPPER: start $(date -u +%FT%TZ)"
GOT="$(git -C "$HERE/../../../.." rev-parse HEAD 2>/dev/null)"
if [ -z "$EXPECTED_SHA" ] || [ "$GOT" != "$EXPECTED_SHA" ]; then
  echo "WRAPPER_FAIL: commit $GOT is not EXPECTED_SHA $EXPECTED_SHA"; exit 10
fi
echo "STEP commit-verified $GOT"
sha256sum -c SHA256SUMS >/dev/null 2>&1; RC=$?
if [ "$RC" -ne 0 ]; then echo "WRAPPER_FAIL: checksum verification failed (rc=$RC)"; sha256sum -c SHA256SUMS; exit 11; fi
echo "STEP checksums-verified 23-of-23"
sh ./schema-restore.sh; RC=$?
echo "RESTORE_EXIT=$RC"
for f in host-exclusion.out target-counts.out staging-fk-definitions.out; do
  echo "----- $f"; [ -f "$f" ] && cat "$f" || echo "(missing)"
done
echo "WRAPPER: end rc=$RC $(date -u +%FT%TZ)"
exit "$RC"
