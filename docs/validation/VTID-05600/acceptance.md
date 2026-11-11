# VTID-05600 acceptance (staging-verify-manifest-repair / console-probes-a)

AC-1 Each expected Operator Console string is present in the file its probe now requests (operator-console.js for the moved probes, app.js for the rest).
TEST: node check over VTID-04887, 04975, 04984, 04999 (outputs/t1-after-green.txt): 30 of 30 present.

AC-2 The baseline is red on origin/main before the edit (8 strings missing from app.js).
TEST: outputs/t1-baseline-red.txt and commands.log section "T1 baseline".

AC-3 Each edited manifest still validates with the staging-verify validator, and existing entries are untouched.
TEST: commands.log section "validateManifest": all four valid.

AC-4 Index probes of the four manifests also expect operator-console.js?v=20261121-vtid-05082 (index.html line 31).
TEST: node check, index probe rows in outputs/t1-after-green.txt.
