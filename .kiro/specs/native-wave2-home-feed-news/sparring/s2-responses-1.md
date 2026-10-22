# Sparring responses — session 2, round 1 (session d108df80)

Both accepted and fixed. The partner verified 13 premises against real code; the two remaining items are a
missing CI step and a stale-snapshot note — the one load-bearing check (feed-compose IO-free) I re-confirmed
directly on origin/main.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct — the test plan listed core-closure --check but not --write. Adding re-export entries to packages/core/src/ without running `node scripts/native/core-closure.mjs --write` and committing the regenerated packages/core/closure.generated.json + scripts/native/mobile-ci-paths.generated.json makes --check fail in NATIVE-CI with 'stale generated file' (core-closure.mjs:12). Fixed: the Test plan now has an explicit 'Core extraction deliverable' bullet requiring the re-export PR to run --write and commit both generated files in the same PR, then --check passes; parity-ledger --check stays listed separately."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Accepted. The 'Measured state' line counts are an approximate scoping snapshot and a few files have grown (news-feed-ranker, useAllNewsFeed, FindPartner); exact counts are not load-bearing and the Measured-state note now says so. The ONE load-bearing case the finding flags — feed-compose.ts being IO-free, which the whole core-extraction argument rests on — I re-read directly on origin/main: feed-compose.ts is 98 lines, its only import is `import type { FeedItem, FeedItemKind } from \"@/lib/news-feed-ranker\"` (type-only), and the tail (the withHomeNewCards helper + HOME_NEW_CARD_CAP) contains no runtime import. So it extracts as class A and core-closure --check will pass after --write. Recorded in the plan's Measured-state note."
  }
]
```

## Note for the next round
All findings across both sessions are resolved and every premise is partner-verified against the live vitana-v1
code and scripts: core extraction = feed-compose + news-feed-ranker only (both class A; --write+commit step now in the
deliverable), hooks native, matchReason/post-attachment type-only (no core PR), home/community-hub/news partition
9+2+16=27 with the three /home exclusion rows flipped to native, and feed-compose confirmed IO-free. No open judgment
call remains — the plan is internally consistent and ledger/closure-accurate, ready to converge.
