# VTID-05129 outputs

- Diagnosis input: full run https://github.com/exafyltd/vitana-platform/actions/runs/38295808979 (community-app @ bcae4d0a): 16 failing suites, all test/runner defects (see plan-sparring.md).
- Proof run 1: https://github.com/exafyltd/vitana-platform/actions/runs/38363989362 (community-app @ 7d9c5707, full): 518 passed, 5 failed (was 16); cancelled at the 45-min job timeout during the after-run deploy check.
  - VTID-04901, VTID-04902 (07:58): staging swapped to 2a193a17 mid-run (stage deploy 38365656444, 07:54–08:00) — the old index chunk was gone. Not a defect; the after-run check exists for this.
  - VTID-04989 `/`: "fetch failed" again, no listed cause code, so no retry → fix-forward 1 (AC-8).
  - VTID-04973: now measured correctly (post,info,post,info,…); the first slot is VitanaIndexCard, which renders nothing for the account (empty:hidden) — composeFeed's documented trade-off → spec checks the slot order in the DOM (vitana-v1).
  - VTID-05081 phone journey: 1 of 4 journey runs in the same full run waited >10 s on one live-room cover image (the other 3: Events ready in ~1 s). External image latency; unchanged, re-observed in proof run 2.
  - Job timeout → AC-9.
- Proof run 2: https://github.com/exafyltd/vitana-platform/actions/runs/38372005093 (community-app @ 44a4f53e, full): 264 passed, 5 failed. Every one of the 16 original failures passes (VTID-04989 recovered via the new retry: "retrying GET … after fetch failed (EPIPE: write EPIPE)"; VTID-04973 passes with the slot-order check). Remaining:
  - VTID-05107 design-contract spec (`__dirname` in ESM): another VTID's suite, already fixed on main by its owner (51bc5e37).
  - VTID-04909 desktop (09:07:24): staging switched to 51bc5e37 mid-run (deploy 09:02–09:08); the same test passed 26 s later in the next invocation.
  - deploy after-run: staging moved on to 7e3abbed (deploy 09:06–09:15) — correct detection.
  - VTID-05062 / VTID-05081 phone journey: Postfach first visit 4454 / 4354 ms vs the 4000 ms budget (waiting on the /inbox route chunk), on the 7e3abbed build; the same step read 3262 and 2006 ms in the run's other two journeys.
- Proof run 3: full run on 7e3abbed — to be recorded here.
