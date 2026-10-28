# Sparring round 1 — in_progress

Session: `d108df80-fd56-498d-a0de-871c4c939a4b` · plan hash `07f3adf2da9ed944dbbe6a19d85f517577383a377915c596a1cc52eb2504a97a`

## Summary

Thirteen premises verified against read_file results. Three hold cleanly and without caveat: shapeOf() at parity-ledger.mjs:60, type-only-import exclusion at extraction-deps.mjs:183-184, and tsconfig @/* alias at line 11. The four import-chain premises cited in Decision 2 all hold at exactly the stated lines (matchReason:1→i18n-toast, post-attachment:11→supabase, useAllNewsFeed:18→supabase, useNewsFeed:10→supabase). The App.tsx route-range premises all hold. Two issues found: the test plan omits the mandatory `core-closure.mjs --write` + generated-file commit step, which will cause NATIVE-CI to fail; and every "Measured state" line count is understated (stale snapshot), with the unread tail of feed-compose.ts being the only one whose content is load-bearing for the core-extraction argument.

## Findings

### R1-F1 [major]

`core-closure.mjs --write` is not listed as a PR deliverable. Adding re-export entries to `packages/core/src/` without running `--write` and committing the two generated files (`closure.generated.json`, `mobile-ci-paths.generated.json`) causes `--check` to fail with 'stale generated file' in NATIVE-CI. The test plan lists only `--check`.

- `exafyltd/vitana-v1:scripts/native/core-closure.mjs:12` — --write   writes packages/core/closure.generated.json (what the native
             resolver guard admits from src/) and
             scripts/native/mobile-ci-paths.generated.json
  --check   fails on: a closure module that is not class A (own or
             transitive), a production-host literal anywhere in packages/**,
             a re-export missing from packages/core/manifest.json (or a
             manifest line nothing re-exports), `@/` outside the entry files,
             a bare import apps/mobile does not depend on or a web-only
             package, or a stale generated file
- `exafyltd/vitana-v1:scripts/native/core-closure.mjs:150` — for (const rel of [...closure].sort()) {
      const m = modules[rel];
      if (!m) continue;
      if (m.own !== 'A') {
        const sig = m.signals.slice(0, 3).map((s) => `${s.type} \`${s.detail}\` L${s.line}`).join('; ');
        errors.push(`${rel} is class ${m.own} (${sig}) and core reaches it: ${chainTo(rel).join(' -> ')}`);
      }
    }

Suggestion: Whichever lane PR adds the re-export entries to `packages/core/src/` must also run `node scripts/native/core-closure.mjs --write` and commit the regenerated `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in that same PR. Add this as an explicit checklist item in the lane deliverable (e.g. home-lane or a prerequisite core-extraction PR). Without it, every NATIVE-CI run will exit non-zero on '--check … stale generated file' regardless of whether the re-exported modules are actually class A.

### R1-F2 [minor]

Every 'Measured state' web-source line count is understated, indicating they were recorded against a snapshot earlier than the pinned commit. Confirmed divergences: `news-feed-ranker.ts` 351 stated / 380 actual; `useAllNewsFeed.ts` 676/719; `useNewsFeed.ts` 306/346; `feed-compose.ts` 98/110+; `community/FindPartner.tsx` 780/836. The unread lines 99–110 of `feed-compose.ts` are the only load-bearing case: the plan's entire core-extraction justification rests on that file being IO-free, and those final lines were never read to confirm no runtime import appears there.

- `exafyltd/vitana-v1:src/lib/news-feed-ranker.ts:378` —         : "featureAnnouncementCard.didYouKnow.eyebrow";
  }
}
- `exafyltd/vitana-v1:src/hooks/useAllNewsFeed.ts:717` —     refetch: () => {
        candidatesQuery.refetch();
        matchesQuery.refetch();
        newsQuery.refetch();
      },
    };
}
- `exafyltd/vitana-v1:src/hooks/useNewsFeed.ts:344` —     staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
- `exafyltd/vitana-v1:src/lib/feed-compose.ts:90` —   for (const item of stream) out.push({ type: "item", item, role: "stream", placement: placementOf(item) });
  return out;
}

/**
 * VTID-05085 — Home takes at most this many NEW Unified Card System cards
 * (top 2 open enrichment cards now, plus 1 boost card in Phase 3).
- `exafyltd/vitana-v1:src/pages/community/FindPartner.tsx:775` — function SuggestedMatches({ members, loading, onPostWish, onOpenMember }: SuggestedMatchesProps) {
  if (!loading && members.length === 0) {
    return (
      <EmptyState
        icon={<Heart className="h-10 w-10 text-muted-foreground mb-3" />}

Suggestion: Before finalising the lane plans, re-measure all cited source files at the pinned commit and update the 'Measured state' table. More critically, read lines 99–110 of `feed-compose.ts` (the 12 lines not covered at the pinned commit) and confirm no runtime import (`import {…} from` without `type`) appears there. If one does, `core-closure --check` will fail even after `--write` is run correctly.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
