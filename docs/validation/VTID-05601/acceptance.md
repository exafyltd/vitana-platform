# VTID-05601 acceptance (staging-verify-manifest-repair / console-probes-b)
- T1 baseline: 10 strings red on origin/main, all in app.js (05003 3, 05004 3, 05064 1, 05069 2, 05071 1). See commands.log.
- T2: 05003 tests[2], 05004 tests[1], 05064 tests[1], 05069 tests[6], 05071 tests[3] re-pathed to operator-console.js?v=20261121-vtid-05082. Strings unchanged.
- T3: index probes of 05003, 05004, 05069, 05071 also expect operator-console.js?v=20261121-vtid-05082. 05064 gets a new index probe at the end of its list (existing indexes unchanged) expecting both script tags.
- T4: 39 of 39 expected strings present; all five manifests validate; VTID-05064 tests[0] and every existing ref unchanged (the one existing line that changed only gained a trailing comma).
- Staging proof: the five suites run on the next full gateway STAGING-VERIFY after merge (read-only).
