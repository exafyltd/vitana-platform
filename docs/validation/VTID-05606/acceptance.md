# VTID-05606 acceptance (staging-verify-manifest-repair / shadow-retired)

AC-1 The deleted recall-shadow suite is retired from VTID-04784 with the VTID-05556 evidence. The alive check stays.
TEST: outputs/baseline-red.txt (test file missing on origin/main) and VTID-04784 manifest validates (commands.log).

AC-2 The deleted path is removed from VTID-05007's one ref. Its other three paths are kept.
TEST: commands.log section "VTID-05007" and git diff (1 line).

AC-3 Both manifests validate with the staging-verify validator.
TEST: commands.log section "validateManifest": 04784 valid, 05007 valid.
