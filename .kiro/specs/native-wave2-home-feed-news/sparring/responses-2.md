# Sparring responses — round 2 (session 80ec8512)

Both accepted. The partner traced the full core-closure BFS and was right that my R1-F1 fix would have
introduced a blocker. Decision 2 is rewritten accordingly.

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct — my 're-export PR for matchReason and post-attachment' remedy was itself a blocker. A core re-export entry puts those files in core-closure.mjs's BFS roots, and their RUNTIME imports (matchReason.ts:1 -> @/lib/i18n-toast; post-attachment.ts:11 -> @/integrations/supabase/client.ts) pull the class-B client.ts (import.meta.env / localStorage / prod Supabase URL) into the closure, which core-closure --check rejects (core-closure.mjs:150, m.own !== 'A'). And it is unnecessary: news-feed-ranker.ts:23-24 import them type-only, which extraction-deps.mjs:183 excludes from the runtime graph, and apps/mobile/tsconfig.json:11 (@/* -> ../../src/*) already resolves the types at compile time. Fixed: Decision 2 now gives core entries to feed-compose and news-feed-ranker ONLY; matchReason and post-attachment get no core PR (type alias covers them); any needed type is inlined into the generated extract, never re-exported from the web file."
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Correct — the 'feed-hook modules move into @vitana/core' heading was wrong. useNewsFeed.ts:10 and useAllNewsFeed.ts:18 runtime-import @/integrations/supabase/client.ts (class B), so a core entry for either fails the closure gate. Fixed: Decision 2 explicitly states the hooks are NOT moved into core; the home lane re-implements the data fetching natively (native Supabase client + native auth context) and consumes composeFeed/rankFeed from core. The core extraction is exactly the two pure modules feed-compose + news-feed-ranker."
  }
]
```

## Note for the next round
Decision 2 is now closure-safe: two pure modules in core, no class-B file reachable, type-only deps handled by the
native tsconfig alias / inline extract, and the data hooks re-implemented natively in the home lane. R1-F2 (partition)
was already closed in round 1. The plan's core-extraction premises are all partner-verified against the real
vitana-v1 code and the closure/extraction scripts.
