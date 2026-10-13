# VTID-05129 outputs

- Diagnosis input: full run https://github.com/exafyltd/vitana-platform/actions/runs/38295808979 (community-app @ bcae4d0a): 16 failing suites, all test/runner defects (see plan-sparring.md).
- Proof run 1: https://github.com/exafyltd/vitana-platform/actions/runs/38363989362 (community-app @ 7d9c5707, full): 518 passed, 5 failed (was 16); cancelled at the 45-min job timeout during the after-run deploy check.
  - VTID-04901, VTID-04902 (07:58): staging swapped to 2a193a17 mid-run (stage deploy 38365656444, 07:54–08:00) — the old index chunk was gone. Not a defect; the after-run check exists for this.
  - VTID-04989 `/`: "fetch failed" again, no listed cause code, so no retry → fix-forward 1 (AC-8).
  - VTID-04973: now measured correctly (post,info,post,info,…); the first slot is VitanaIndexCard, which renders nothing for the account (empty:hidden) — composeFeed's documented trade-off → spec checks the slot order in the DOM (vitana-v1).
  - VTID-05081 phone journey: 1 of 4 journey runs in the same full run waited >10 s on one live-room cover image (the other 3: Events ready in ~1 s). External image latency; unchanged, re-observed in proof run 2.
  - Job timeout → AC-9.
- Proof run 2: to be recorded here.
