# Evidence — vitana-v1 excerpts at the pinned SHA

Machine-generated with `git -C vitana-v1 show e31bf4627ff3c705c20f8e6b718ce4dd03353b7f:<path>`. vitana-v1 is not pinned in the PLAN-SPAR session, so the premises of `plan.md` are quoted here verbatim, with line numbers and sha256 of each whole file. Pinned: vitana-v1 origin/main e31bf4627ff3c705c20f8e6b718ce4dd03353b7f.

## `apps/mobile/app/(app)/intents/mine.tsx` sha256 3a23f2b2277370c6
```
     1	/**
     2	 * VTID-05296 (N-W2 community-hub) — route /intents/mine. Ledger row
     3	 * INTENTS.MINE. The web mobile branch redirects My Intents to the Find a
     4	 * Partner "My Posts" view (`MyIntents.tsx`: `<Navigate to="/comm/find-partner?view=posts" replace />`),
     5	 * so the native app — which is always the mobile surface — does the same.
     6	 */
     7	import { Redirect } from 'expo-router';
     8	
     9	export default function MyIntentsRoute() {
    10	  return <Redirect href={'/comm/find-partner?view=posts' as never} />;
    11	}
```

## `apps/mobile/app/(app)/comm/my-groups/[id].tsx` sha256 278981e5065649b4
```
     1	/**
     2	 * VTID-05296 (N-W2 community-hub) — legacy route /comm/my-groups/:id (ledger
     3	 * row /comm/my-groups/:id, an exclusion alias). Renders the same group detail
     4	 * as /comm/groups/:id, matching the web alias.
     5	 */
     6	import { useLocalSearchParams } from 'expo-router';
     7	import { GroupDetailScreen } from '../../../../src/screens/community/GroupDetailScreen';
     8	
     9	export default function MyGroupDetailRoute() {
    10	  const { id } = useLocalSearchParams<{ id?: string }>();
    11	  return <GroupDetailScreen id={id} />;
    12	}
```

## `apps/mobile/parity/ledger.json` rows (sha256 720638c81fd68bc3)
```
1601:      "key": "INTENTS.MINE",
1602-      "web_path": "/intents/mine",
1603-      "kind": "screen",
1604-      "source": "registry",
1605-      "scope": "in",
1606-      "lane": "home-feed",
1607-      "status": "native",
1608-      "exception": null,
1609-      "owner": "kiro",
1610-      "last_parity_check": "2026-10-21"
1611-    },
--
2465:      "key": "/comm/my-groups/:id",
2466-      "web_path": "/comm/my-groups/:id",
2467-      "kind": "route",
2468-      "source": "exclusion",
2469-      "scope": "in",
2470-      "lane": "home-feed",
2471-      "status": "native",
2472-      "exception": null,
2473-      "owner": "kiro",
2474-      "last_parity_check": "2026-10-21"
2475-    },
--
```

## `apps/mobile/src/navigation/resolve.ts` (sha256 87a758194d9d27f9)
```
90:    90	  '/intents/mine',
154:   154	export const NATIVE_PATTERNS: readonly string[] = ['/discover/provider/:id'];
195:   195	export function resolveWebPath(url: string, depth = 0): Resolution {
214:   214	  const candidates = ROWS.filter((r) => matchPattern(r.web_path, path));
```
(`grep -c my-groups` on resolve.ts = 0)

## `apps/mobile/jest.config.js`
```
     9	  roots: ['<rootDir>/tests'],
    10	  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
    11	  resolver: '<rootDir>/resolution.js',
    12	  setupFiles: ['<rootDir>/jest.setup.ts'],
    13	  moduleNameMapper: {
    14	    // lucide-react-native's "react-native" entry is untranspiled ESM (.mjs); jest takes its CommonJS build.
    15	    '^lucide-react-native$': '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js',
    16	  },
    17	};
```

## Test search at the pinned SHA
```
git grep -n 'intents/mine' e31bf4627ff3c705c20f8e6b718ce4dd03353b7f -- apps/mobile/tests: 0 hits
git grep -n 'my-groups' e31bf4627ff3c705c20f8e6b718ce4dd03353b7f -- apps/mobile/tests: 0 hits
e31bf4627ff3c705c20f8e6b718ce4dd03353b7f:apps/mobile/tests/community/groups.test.tsx:8:import { GroupDetailScreen } from '../../src/screens/community/GroupDetailScreen';
e31bf4627ff3c705c20f8e6b718ce4dd03353b7f:apps/mobile/tests/community/groups.test.tsx:102:describe('GroupDetailScreen', () => {
e31bf4627ff3c705c20f8e6b718ce4dd03353b7f:apps/mobile/tests/community/groups.test.tsx:110:    render(<GroupDetailScreen id="g-1" />, { wrapper: makeCommunityWrapper({ client: d.client }) });
apps/mobile/tests/community/composer.test.tsx
apps/mobile/tests/community/find-partner.test.tsx
apps/mobile/tests/community/groups.test.tsx
apps/mobile/tests/community/helpers.tsx
apps/mobile/tests/community/intents.test.tsx
apps/mobile/tests/community/matches.test.tsx
apps/mobile/tests/community/members.test.tsx
apps/mobile/tests/community/mocks.ts
apps/mobile/tests/community/open-asks.test.tsx
apps/mobile/tests/community/search.test.tsx
apps/mobile/tests/helpers/mocks.ts
apps/mobile/tests/helpers/no-network.ts
apps/mobile/tests/helpers/providers.tsx
apps/mobile/tests/helpers/supabase-double.ts
```

## Script location
```
scripts/native/parity-ledger.mjs
```
`scripts/native/parity-ledger.mjs` lives in vitana-v1; run from the vitana-v1 root. Result recorded in the audit: `OK — 435 rows, 121 native route(s)`.
