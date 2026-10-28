# Sparring round 2 — in_progress

Session: `80ec8512-302f-4261-8134-3f8a34b0cc3b` · plan hash `e5b673e7613f6853022c5d3ad902d9b681cd14cca86488aa477279c7bc53a04b`

## Summary

Both prior findings were accepted and revised. R1-F2 (partition count) is correctly fixed and can be closed. R1-F1 (under-scoped core extraction) was accepted and the revision identifies the right transitive modules, but the proposed fix — giving `matchReason` and `post-attachment` "each their own re-export PR" — would break `core-closure --check` by pulling `src/integrations/supabase/client.ts` (class B: vite+localStorage+prod-host) into the closure. This is a new blocker introduced by the revision. A second new finding (major) is that Decision 2's heading claims "feed-hook modules move into @vitana/core" while the exhaustive implementation list excludes the actual hook files; moving those hooks would also fail the closure gate via `client.ts`.

## Findings

### R2-F1 [blocker]

The revised R1-F1 fix directs each of `matchReason` and `post-attachment` to get 'their own re-export PR' in @vitana/core. Adding a core re-export entry (even a type-only `export type … from '@/lib/matchReason'`) causes core-closure.mjs's BFS to add those web-side files to `roots` and process their runtime import graph. `src/lib/matchReason.ts:1` has the runtime import `import { t } from "@/lib/i18n-toast"`, and `src/lib/post-attachment.ts:11` has the runtime import `import { supabase } from "@/integrations/supabase/client"`. `src/integrations/supabase/client.ts` carries three class-B signals that core-closure --check rejects (line 153: `m.own !== 'A'`): `import.meta.env` (vite) on lines 11/15/20, `localStorage` (storage) on line 27, and the production Supabase URL literal `inmkhvwdcuyhnxkgfvsb.supabase.co` (prod-fallback) on line 12. A class-B module in the closure is a hard --check error. The re-export PRs are also unnecessary: `news-feed-ranker.ts` uses only `import type` from both modules (lines 23-24), which extraction-deps.mjs line 184 (`if (!isTypeOnlyImport(n)) imports.push(...)`) excludes from the runtime graph, and the native tsconfig maps `@/*` → `../../src/*` (apps/mobile/tsconfig.json line 11) so TypeScript already resolves these types at compile time without any core entry file.

- `exafyltd/vitana-v1:src/lib/matchReason.ts:1` — import { t } from "@/lib/i18n-toast";
- `exafyltd/vitana-v1:src/lib/post-attachment.ts:11` — import { supabase } from "@/integrations/supabase/client";
- `exafyltd/vitana-v1:src/integrations/supabase/client.ts:11` — const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  "https://inmkhvwdcuyhnxkgfvsb.supabase.co";
...
  auth: {
    storage: localStorage,
- `exafyltd/vitana-v1:scripts/native/core-closure.mjs:150` — for (const rel of [...closure].sort()) {
  const m = modules[rel];
  if (!m) continue;
  if (m.own !== 'A') {
    const sig = m.signals.slice(0, 3).map((s) => `${s.type} \`${s.detail}\` L${s.line}`).join('; ');
    errors.push(`${rel} is class ${m.own} (${sig}) and core reaches it: ${chainTo(rel).join(' → ')}`);
- `exafyltd/vitana-v1:scripts/native/extraction-deps.mjs:183` — if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
  if (!isTypeOnlyImport(n)) imports.push({ spec: n.moduleSpecifier.text, line: lineOf(sf, n) });
- `exafyltd/vitana-v1:src/lib/news-feed-ranker.ts:23` — import type { MatchReason } from "@/lib/matchReason";
import type { PostAttachedRef } from "@/lib/post-attachment";
- `exafyltd/vitana-v1:apps/mobile/tsconfig.json:11` — "@/*": ["../../src/*"]

Suggestion: Drop the 'matchReason and post-attachment each get their own re-export PR' directive entirely. Because news-feed-ranker.ts uses only `import type` from both, extraction-deps.mjs excludes them from the runtime graph; the native tsconfig `@/*` alias already makes them resolvable for TypeScript without any core entry file. Decision 2 should state: only `feed-compose` and `news-feed-ranker` receive core re-export entry files; `matchReason` and `post-attachment` require no core PR (the type alias in apps/mobile/tsconfig.json covers them). If the implementer needs to inline `MatchReason` or `PostAttachedRef` into core for some other reason, it must be done as a type-only inline in the generated extract (not as a re-export that puts the web-side file in the BFS roots).

### R2-F2 [major]

Decision 2 opens with 'Feed-composition / ranking / feed-hook modules move into @vitana/core', yet the exhaustive implementation list that follows only names `feed-compose`, `news-feed-ranker`, `matchReason`, `post-attachment`. The actual hook files `useNewsFeed.ts` and `useAllNewsFeed.ts` are mentioned only as sources to scan for transitive type imports, not as modules being moved. If an implementer takes the heading at face value and creates core re-export entries for either hook, both fail the closure gate: `useAllNewsFeed.ts` line 18 has the runtime import `import { supabase } from "@/integrations/supabase/client"` and line 19 imports from `@/integrations/supabase/realtime`, and `useNewsFeed.ts` line 10 has the runtime import `import { supabase } from "@/integrations/supabase/client"` — all routes to the class-B `client.ts` in the closure.

- `exafyltd/vitana-v1:src/hooks/useAllNewsFeed.ts:18` — import { supabase } from "@/integrations/supabase/client";
import { realtimeChannel, removeRealtimeChannel } from '@/integrations/supabase/realtime';
- `exafyltd/vitana-v1:src/hooks/useNewsFeed.ts:10` — import { supabase } from "@/integrations/supabase/client";
- `exafyltd/vitana-v1:src/integrations/supabase/client.ts:27` —     storage: localStorage,
- `exafyltd/vitana-v1:scripts/native/core-closure.mjs:150` — if (m.own !== 'A') {
    const sig = m.signals.slice(0, 3)...
    errors.push(`${rel} is class ${m.own} (${sig}) and core reaches it:...

Suggestion: Remove 'feed-hook modules' from the Decision 2 heading. The decision should clearly state: only the pure, IO-free modules (`feed-compose`, `news-feed-ranker`) are re-exported from @vitana/core; the data-fetching hooks (`useNewsFeed`, `useAllNewsFeed`) are NOT moved into core and will be re-implemented natively per screen in the `home` lane, consuming `rankFeed`/`composeFeed` from core against the native Supabase client and native auth context.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The original concern (under-scoped extraction leaving @/lib/* imports in core copies) was correctly identified and the revision correctly names the transitive modules. However, the proposed remedy — 're-export PRs' for matchReason and post-attachment — introduces a new blocker (R2-F1): those PRs would pull src/integrations/supabase/client.ts (class B) into the core closure. The finding itself is closed; the mis-fix is raised as R2-F1.
- R1-F2: acknowledged — Correctly fixed. The partition is now stated as home 6 + news 2 + community-hub 19 = 27, consistent with the four HOME.* ledger rows verified at ledger.json:1469-1514, the three /home deep-link sub-routes explicitly excluded from row accounting, and the '0 orphan / only status flips' gate. No residual issue.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
