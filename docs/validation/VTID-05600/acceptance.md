# VTID-05600 acceptance (staging-verify-manifest-repair / console-probes-a)

- T1 baseline: 8 strings red, all in app.js (VTID-04887 1, VTID-04975 2, VTID-04984 2, VTID-04999 3). See commands.log.
- T2: VTID-04887 tests[6] split. The fetch string moved to a new operator-console.js probe; five strings stay on app.js.
- T3: VTID-04975 tests[4], VTID-04984 tests[2] and VTID-04999 tests[3] re-pathed to operator-console.js?v=20261121-vtid-05082. Strings unchanged.
- T4: each manifest's /command-hub/ index probe also expects operator-console.js?v=20261121-vtid-05082 (index.html line 31).
- T5: after the edits the string check reports 30 of 30 present. All four manifests validate with lib.validateManifest. Existing entries are untouched.
- Staging proof: the four suites run on the next full gateway STAGING-VERIFY after merge. The probes are read-only.
