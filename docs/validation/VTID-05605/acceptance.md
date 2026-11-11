# VTID-05605 acceptance (staging-verify-manifest-repair / ref-05331)

AC-1 The VTID-05331 manifest validates with the staging-verify validator (red on origin/main).
TEST: outputs/baseline-red.txt (INVALID before) and outputs/after-green.txt (valid after).

AC-2 The four collab suites run through a valid root npm script (test:collab-rules), so their ref is accepted by the validator.
TEST: outputs/test-collab-rules.txt (node --test over queue, plan-spar, plan-driver and automations suites).

AC-3 Only package.json (one new script) and the VTID-05331 manifest change. Existing entries and the other manifests are untouched.
TEST: git diff --stat for this PR (2 files).
