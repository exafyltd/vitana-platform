# VTID-05601 acceptance (staging-verify-manifest-repair / console-probes-b)

AC-1 Each expected Operator Console string is present in the file its probe now requests (operator-console.js for the moved probes, app.js for the rest).
TEST: node check over VTID-05003, 05004, 05064, 05069, 05071 (outputs/t1-after-green.txt): 39 of 39 present.

AC-2 The baseline is red on origin/main before the edit (10 strings missing from app.js).
TEST: outputs/t1-baseline-red.txt and commands.log section "T1 baseline".

AC-3 Each edited manifest still validates with the staging-verify validator, and existing entries are untouched (VTID-05064 tests[0] unchanged).
TEST: commands.log section "validateManifest": all five valid.

AC-4 Index probes of 05003, 05004, 05069 and 05071 also expect operator-console.js?v=20261121-vtid-05082; VTID-05064 gets a new index probe expecting both script tags.
TEST: node check, index probe rows in outputs/t1-after-green.txt.
