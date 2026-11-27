#!/usr/bin/env bash
# Parent decision OD-2 (brief item 4): the refused names live in scripts/aws/staging-cutover-refused-names.txt, which is not
# in the flip's enforce-guard file list. Two negative tests hold the rule. The list must keep every production literal. The
# guard must still refuse each literal that it knows in every deployable cutover script. The guard itself is not changed.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

GUARD="$REPO_ROOT/scripts/ci/staging-prod-ref-guard.mjs"
# The flip's enforce-guard files, read from the workflow's own run line.
flip_enforce_files() { sed -n 's/.*staging-prod-ref-guard\.mjs --enforce --files //p' "$CUTOVER_WORKFLOW" | head -n 1; }

t_refusal_list_keeps_every_production_literal() {
  # Deleting any one of these lines from the list fails this test. The rehearsal clone is refused too (brief item 3).
  new_sandbox
  local literal
  for literal in 'vitana-aurora-prod' 'rds!cluster-4dab93b8' 'vitana/aurora/prod/' 'vitana/supabase/prod/' 'vitana/aurora/rehearsal/'; do
    grep -Eq "$REFUSED_NAME_RE" <<<"$literal" || fail_expect "the refused-names list does not refuse '$literal'"
  done
}

t_refusal_list_is_outside_the_flip_enforce_set() {
  # The literals sit in the list because the list is not scanned. If the list is ever added to the enforce set, the flip's
  # guard would refuse its own refusal list, so this test fails first.
  new_sandbox
  local files
  files=$(flip_enforce_files)
  [ -n "$files" ] || { fail_expect "the flip's enforce-guard file list is missing from AWS-STAGE-CUTOVER.yml"; return 0; }
  case " $files " in *" scripts/aws/staging-cutover-refused-names.txt "*) fail_expect "the refused-names list is in the flip's enforce set" ;; esac
}

t_deployable_cutover_scripts_pass_the_guard_as_they_are() {
  # Control: the flip's enforce guard passes on the repository's own cutover scripts.
  new_sandbox
  local files
  files=$(flip_enforce_files)
  # shellcheck disable=SC2086
  run_env -- node "$GUARD" --enforce --files $files
  expect_ok
  expect_out '0 production reference'
}

t_literal_is_refused_in_every_deployable_cutover_script() {
  # For each deployable script of the flip, a copy with one known production literal appended must be refused (exit 1).
  # The guard knows three of the four literals. The fourth is held by the refused-names list test above.
  local files file literal copy
  files=$(flip_enforce_files)
  for file in $files; do
    for literal in 'vitana-aurora-prod' 'vitana/aurora/prod/postgrest-authenticator-uri' 'vitana/supabase/prod/jwt-secret'; do
      new_sandbox
      copy="$SANDBOX/$(basename "$file")"
      cp "$REPO_ROOT/$file" "$copy"
      printf '\n# injected for the negative test: %s\n' "$literal" >> "$copy"
      run_env -- node "$GUARD" --enforce --files "$copy"
      expect_refused
      expect_out 'production'
      [ "$RC" -eq 1 ] || fail_expect "$file with '$literal' exited $RC, not 1 (the guard must refuse it)"
    done
  done
}

run_all_tests
