# Sparring round 1 — in_progress

Session: `12d09af7-a668-4c34-91e0-f7dbf010f29d` · plan hash `caeba7c00d3255ddd2841ce3c8d4b12e63770d8dd520594b2f1c2b7861470ecf`

## Summary

I verified several key premises of the plan against the pinned commit. The core IO-free claims about feed-compose.ts and news-feed-ranker.ts (type-only imports) hold. The tsconfig alias, resolver route existence, and supabase import locations in the hooks all check out. However, the plan claims news-feed-ranker.ts is ~351 lines while it is actually 380 lines — the extra 29 lines at the tail could not be verified as IO-free due to 403 errors mid-session. The parity ledger row count (27 home-feed rows, 435 total) and the script behavior claims (parity-ledger.mjs shapeOf, core-closure.mjs gate, extraction-deps.mjs type exclusion) could not be verified due to access limits. I raise findings only where I have direct read_file evidence.

## Findings

### R1-F1 [minor]

The plan references news-feed-ranker.ts as ~351 lines but the file is actually 380 lines at the pinned commit. While the plan acknowledges line counts are approximate, the 8% discrepancy on a file being extracted to @vitana/core means lines 351-380 were not inspected in the plan's IO-free analysis. These lines could contain runtime imports or side effects that would break the class-A classification. Only lines 1-50 could be verified (confirming type-only imports at lines 23-24 and the ZERO IO doc comment), but the tail is unconfirmed.

- `exafyltd/vitana-v1:src/lib/news-feed-ranker.ts:1` — lines 1-50 of 380 — file header says 'ZERO IO' and lines 23-24 are `import type` only, but file is 380 lines not ~351 as plan states

Suggestion: Before the home lane PR, verify that lines 351-380 of news-feed-ranker.ts contain no runtime imports or side effects. If they do, the core-closure --check will catch it, but it's better to confirm upfront.

### R1-F2 [minor]

The plan understates the complexity of the native feed-fetching re-implementation. It frames the hook exclusion from core as primarily about the supabase/client.ts import, but useAllNewsFeed.ts alone has runtime imports from 8+ non-trivial modules (supabase realtime, query-persist, post-attachment's attachedRefOf, AuthProvider, LanguageContext, i18n-toast, newsFeedPreferencesStore, useRealMatches, useNewsFeed, feed config). The native re-implementation will need to replicate or substitute all of these.

- `exafyltd/vitana-v1:src/hooks/useAllNewsFeed.ts:15` — import { supabase } from "@/integrations/supabase/client";
import { realtimeChannel, removeRealtimeChannel } from '@/integrations/supabase/realtime';
import { persistQueryCacheNow } from "@/lib/query-persist";
import { attachedRefOf } from "@/lib/post-attachment";
import { useAuth } from "@/context/AuthProvider";
import { useLanguage } from "@/contexts/LanguageContext";
import { t } from "@/lib/i18n-toast";
import { useRealMatches } from "@/hooks/useRealMatches";
import { useNewsFeedPreferencesStore } from "@/stores/newsFeedPreferencesStore";
import { useLongevityNewsFeed } from "@/hooks/useNewsFeed";
- `exafyltd/vitana-v1:src/hooks/useNewsFeed.ts:9` — import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthProvider";
import { useLanguage } from "@/contexts/LanguageContext";
import { t } from "@/lib/i18n-toast";
import { GATEWAY_API_URL } from '@/lib/gateway-base';
import { fetchGreetedMemberIds } from "@/lib/new-member-greeted";
import { COMMUNITY_INTRO_COLUMN } from "@/lib/community-intro";

Suggestion: Consider adding a note to the home lane that the native feed-fetching re-implementation must cover: realtime subscriptions, query cache persistence, post-attachment resolution, language-filtered queries, feed preferences, gateway API calls, and new-member greeting state. This scoping helps the implementor and reviewer estimate effort accurately.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
