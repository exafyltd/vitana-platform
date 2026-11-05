#!/usr/bin/env bash
# Compares infra/gitlab-engineering/ of this branch with the archive the owner ran in AWS CloudShell on 2026-11-04 (bundle v6).
# The CloudShell block the owner pasted is kept byte for byte in owner-cloudshell-block-v6.txt: it decodes a base64 archive,
# checks it with `sha256sum -c`, and extracts it. This script does the same decode, checks the same hash, and compares every file.
# usage: compare-with-v6.sh <repository root>     (run from anywhere; needs bash, base64, sha256sum, tar, diff)
set -eu
REPO="${1:?repository root}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BLOCK="$HERE/owner-cloudshell-block-v6.txt"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/v6-XXXXXX")"
trap 'rm -rf "$DIR"' EXIT

sed '1d;/^B64$/,$d' "$BLOCK" | base64 -d > "$DIR/vitana-eng.tgz"
EXPECT="$(sed -n 's/^echo "\([0-9a-f]\{64\}\)  vitana-eng.tgz".*/\1/p' "$BLOCK")"
ACTUAL="$(sha256sum "$DIR/vitana-eng.tgz" | cut -c1-64)"
echo "# archive sha256 $ACTUAL"
echo "# the block checks for   $EXPECT"
[ "$ACTUAL" = "$EXPECT" ] || { echo "MISMATCH: the archive does not match the hash the block checks"; exit 1; }
mkdir "$DIR/v6" && tar -xzf "$DIR/vitana-eng.tgz" -C "$DIR/v6"

echo "# every file of the archive against $REPO/infra/gitlab-engineering (sha256, first 16 characters)"
changed=0
while IFS= read -r f; do
  a="$(sha256sum "$DIR/v6/$f" | cut -c1-16)"
  b="$(sha256sum "$REPO/infra/gitlab-engineering/$f" 2>/dev/null | cut -c1-16)"
  if [ "$a" = "$b" ]; then echo "same     $f  $a"; else echo "CHANGED  $f  archive $a  branch ${b:-missing}"; changed=$((changed + 1)); fi
done < <(cd "$DIR/v6" && find . -type f | sed 's#^\./##' | sort)
echo "# files of the branch that are not in the archive:"
(cd "$REPO/infra/gitlab-engineering" && find . -type f | sed 's#^\./##' | sort) > "$DIR/branch.list"
(cd "$DIR/v6" && find . -type f | sed 's#^\./##' | sort) > "$DIR/archive.list"
comm -13 "$DIR/archive.list" "$DIR/branch.list" | sed 's/^/new      /'
echo "# changed files: $changed"
for f in $(cd "$DIR/v6" && find . -type f | sed 's#^\./##' | sort); do
  if ! cmp -s "$DIR/v6/$f" "$REPO/infra/gitlab-engineering/$f"; then
    echo; echo "# diff -u of $f (archive -> branch)"
    diff -u "$DIR/v6/$f" "$REPO/infra/gitlab-engineering/$f" | sed -e "1s#.*#--- archive/$f#" -e "2s#.*#+++ branch/$f#" || true
  fi
done
