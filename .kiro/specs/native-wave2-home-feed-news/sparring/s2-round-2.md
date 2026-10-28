# Sparring round 2 — in_progress

Session: `d108df80-fd56-498d-a0de-871c4c939a4b` · plan hash `e5591fd03ffaf0d791d7e5dc21f0745a0207475b6d6c3e8e717c0ad7b3e5fe2a`

## Summary

Both Round 1 findings were accepted and the accepted fixes verify correctly in the revised plan. Six premises were checked against the pinned code: all hold. One new major finding: the core extraction PR (adding re-export entries to `packages/core/src/` and running `--write`) is referenced in the test plan as a named deliverable but is not explicitly assigned to any lane in the lanes table, creating a scope gap that could cause the home lane to be implemented without the required `packages/core/src/` files or with the `--write`+commit step in a separate, uncoordinated PR (violating the "same PR" governance rule). Everything else in the revised plan checks out: row counts, shapeOf matching semantics, type-only import exclusions, class-B chain prevention, check (c) only firing on native/in_progress, and the IO-free premise for feed-compose.ts.

## Findings

### R2-F1 [major]

The core extraction PR—adding re-export entries to `packages/core/src/` for `feed-compose` and `news-feed-ranker`, running `--write`, and committing the two generated files—is not listed as a deliverable in any lane's scope column in the lanes table, and no lane carries a `depends_on: core-extraction` prerequisite. The test plan says 'The PR that adds the `feed-compose`/`news-feed-ranker` re-export entries … MUST also run `--write` … in the SAME PR' but does not identify which lane owns that PR. The home lane scope is described exclusively as '9 parity rows, all flipped `not_started`→`native`'; it says nothing about touching `packages/core/src/`. If the home lane executor treats the scope description literally (parity rows + native route files only), they will either: (a) never add the core re-exports, causing TypeScript compilation to fail on `import { composeFeed } from '@vitana/core/feed-compose'`, or (b) add the re-exports in a separate uncoordinated PR, violating the governance rule that `--write`+commit must be in the same PR as the re-export entries (NATIVE-CI will then flag a stale generated file on whichever PR lacks it).

- `exafyltd/vitana-v1:scripts/native/core-closure.mjs:10` — --write   writes packages/core/closure.generated.json (what the native
             resolver guard admits from src/) and
             scripts/native/mobile-ci-paths.generated.json
  --check   fails on: … a stale generated file
- `exafyltd/vitana-v1:src/lib/feed-compose.ts:27` — import type { FeedItem, FeedItemKind } from "@/lib/news-feed-ranker";
- `exafyltd/vitana-v1:src/lib/feed-compose.ts:100` — export const HOME_NEW_CARD_CAP = 3;

/**
 * Put the new cards in front of Home's existing Vitana cards, capped at
 * HOME_NEW_CARD_CAP. The existing cards keep their order. Runs in Home.tsx
 * BEFORE composeFeed, so composeFeed itself is unchanged.
 */
export function withHomeNewCards<V>(newCards: V[], existingCards: V[], cap: number = HOME_NEW_CARD_CAP): V[] {
  return [...newCards.slice(0, Math.max(0, cap)), ...existingCards];
}
- `exafyltd/vitana-v1:apps/mobile/tsconfig.json:11` — "@/*": ["../../src/*"]

Suggestion: Explicitly assign the core extraction work to the home lane. The home lane scope description (and its `lanes/home.md` deliverable) should include: 'Add re-export entry files `packages/core/src/feed-compose.ts` and `packages/core/src/news-feed-ranker.ts`; in the same PR run `node scripts/native/core-closure.mjs --write` and commit both generated files (`packages/core/closure.generated.json`, `scripts/native/mobile-ci-paths.generated.json`); then `--check` passes.' Alternatively, add a dedicated prerequisite lane/PR (e.g. `core-extraction`) and make home `depends_on: [news, core-extraction]`. Either way the lanes table must have a clear owner so a code reviewer of the home PR knows to check for the generated-file commits, and so no executor treats the core work as a separate out-of-scope PR.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Properly addressed. The revised test plan now has an explicit 'Core extraction deliverable' bullet requiring `--write` + commit of both generated files in the same PR as the re-export entries before `--check` is run. The `core-closure.mjs` --check stale-file guard (lines 10-19) will enforce this. Note however that R2-F1 is the residual scope gap: the test plan now correctly describes *how* the PR must behave, but still does not identify *which* lane owns that PR.
- R1-F2: acknowledged — The load-bearing premise—that `feed-compose.ts` is IO-free—is confirmed at the pinned commit (line 27 is the only import and it is type-only; lines 100-109 add only pure `withHomeNewCards`/`HOME_NEW_CARD_CAP` with no runtime import). The plan's corrective note says '98 lines' but the file is 110 lines at the pinned commit (12 lines added by the `withHomeNewCards` helper, VTID-05085); since the plan already labels line counts approximate and the IO-free claim holds regardless, this residual inaccuracy in the corrective note is not load-bearing.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
