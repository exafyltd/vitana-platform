#!/usr/bin/env bash
# Rebuilds the VTID-05803 v2 execution package reproducibly (same inputs -> same sha256) and its manifest.
# Run from the repository root: bash docs/validation/VTID-05803/package/build-v2.sh
set -euo pipefail
P=docs/validation/VTID-05803/package
FILES=(
  scripts/aws/aurora-cutover-auth-bridge.sql
  scripts/aws/aurora-cutover-outbox.sql
  scripts/aurora/migrations/0001_auth_shim.sql
  docs/validation/VTID-05803/stage-exec.sh
  docs/validation/VTID-05803/inventory.sql
  docs/validation/VTID-05803/source-exclusions.sql
  docs/validation/VTID-05803/source-grants.sql
)
tar --sort=name --owner=0 --group=0 --numeric-owner --mode='u+rw,go+r,go-w' --mtime='2026-11-17 00:00Z' -cf - "${FILES[@]}" \
  | gzip -n -9 > "$P/vtid-05803-exec-v2.tar.gz"
base64 -w0 "$P/vtid-05803-exec-v2.tar.gz" > "$P/vtid-05803-exec-v2.tar.gz.b64"
{
  echo "# VTID-05803 execution package v2 manifest"
  echo "archive: vtid-05803-exec-v2.tar.gz"
  echo "archive_sha256: $(sha256sum "$P/vtid-05803-exec-v2.tar.gz" | cut -d' ' -f1)"
  echo "b64_object: vtid-05803-exec-v2.tar.gz.b64"
  echo "b64_sha256: $(sha256sum "$P/vtid-05803-exec-v2.tar.gz.b64" | cut -d' ' -f1)"
  echo "files (sha256  path):"
  for f in "${FILES[@]}"; do echo "  $(sha256sum "$f")"; done
} > "$P/MANIFEST-v2.txt"
cat "$P/MANIFEST-v2.txt"
