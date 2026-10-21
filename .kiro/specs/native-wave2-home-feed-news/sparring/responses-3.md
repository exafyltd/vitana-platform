# Sparring responses — round 3 (session 80ec8512)

R3-F1 accepted and fixed. The partner confirmed R2-F1 and R2-F2 are fully resolved; R3-F1 is the one
remaining item and its fix is a precise, mechanical ledger re-count (no judgment call).

```json
[
  {
    "finding_id": "R3-F1",
    "disposition": "accepted",
    "rationale": "Correct — I over-corrected in round 1. The three /home/* deep-links DO have dedicated ledger rows (apps/mobile/parity/ledger.json: source=exclusion, scope=in, lane=home-feed, from src/navigation/registry/exclusions.json + scripts/native/parity-scope.json), and parity-ledger.mjs matches by exact shapeOf() (parity-ledger.mjs:60), not prefix, so /home/compose is never 'covered under /home'. My 'no dedicated row / covered under HOME.OVERVIEW' claim was wrong and would have left 3 home-lane rows silently stuck at not_started while their native files exist (check (d) passes via the exclusion rows, check (c) only fires on native/in_progress). Fixed: the home lane is 9 parity rows (4 HOME.* screens + 2 overlays + 3 exclusion routes), community-hub is 16, partition 9+2+16=27; the home-lane acceptance now REQUIRES flipping all three /home/* exclusion rows to native alongside the 6 registry rows. Decision 1 and the lane table are updated consistently."
  }
]
```

## Note for the next round
All three findings across the two real review rounds are now resolved and the premises are partner-verified
against the live vitana-v1 ledger and the parity-ledger/core-closure scripts: core extraction is two pure modules
(no class-B reachable), the feed hooks are native, and the home/community-hub/news partition is 9+2+16=27 with the
three /home exclusion rows flipped to native. The plan is internally consistent and ledger-accurate; it is ready to
converge. (If the session-count cap parks it, the fix above is captured for the coordinator to re-spar a fresh
session — there is no open judgment call, only the corrected counts.)
