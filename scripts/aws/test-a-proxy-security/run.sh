#!/usr/bin/env bash
# Offline negative tests for the proxy security containment changes. Runs every test-*.sh file in
# this directory and exits 0 only when all of them pass.
#
# No test calls AWS, reads a secret, or connects to a host: each external command resolves to a stub
# (see lib.sh). Run from anywhere: bash scripts/aws/test-a-proxy-security/run.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_TMP="$(mktemp -d "${TMPDIR:-/tmp}/proxy-security-tests.XXXXXX")"
export TESTS_TMP
trap 'rm -rf "$TESTS_TMP"' EXIT

pass=0
fail=0
for file in "$DIR"/test-*.sh; do
  while IFS= read -r line; do
    case "$line" in
      "PASS "*) pass=$((pass + 1)) ;;
      "FAIL "*) fail=$((fail + 1)) ;;
    esac
    printf '%s\n' "$line"
  done < <(bash "$file" 2>&1)
done
printf 'SUMMARY pass=%s fail=%s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
