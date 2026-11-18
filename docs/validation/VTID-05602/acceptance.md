# VTID-05602 acceptance (staging-verify-manifest-repair / drift-guard)

AC-1 The guard fails a manifest that lib.validateManifest rejects (check 1).
TEST: outputs/baseline-red.txt: check 1 names VTID-05504, 05506, 05507, 05609 on origin/main.

AC-2 The guard fails a served command-hub .js or .css file that lacks an expected string (check 2), and an index probe whose string is missing from index.html (check 3).
TEST: manifest-drift.test.cjs checks 2 and 3 pass on the current tree (outputs/baseline-red.txt).

AC-3 The guard fails an existing jest or vitest ref whose file does not exist (check 4), and an http probe with an unknown key (check 5).
TEST: manifest-drift.test.cjs checks 4 and 5 pass on the current tree.

AC-4 The guard runs in STAGING-TESTS-REQUIRED's runner unit test step.
TEST: .github/workflows/STAGING-TESTS-REQUIRED.yml line 39 lists manifest-drift.test.cjs.

AC-5 The guard is green once the four remainder manifests (plan staging-manifest-remainder) are fixed.
TEST: CI on this PR is red until that plan lands; the red set is recorded in outputs/baseline-red.txt.
