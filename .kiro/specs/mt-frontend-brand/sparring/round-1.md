# Sparring round 1 — in_progress

Session: `ab1a55f8-5be9-4511-9e5d-6ef792ba421f` · plan hash `defafc076fb11cf89ef1df5ada8dc9fe3e4aa6210302c7b67ec7880843117377`

## Summary

The plan covers six lanes across two repos. Only one repo (exafyltd/vitana-platform) is pinned; the other (exafyltd/vitana-v1) has no pinned ref in this session, making the majority of the plan's premises structurally unverifiable. Of the verifiable premises in vitana-platform, the MIGRATION-QUEUE last-applied row, the CORS hardcoded-array structure, the PROTECTED_PATH, ALLOWED_VTID_PATTERN location, and the admin-tenants GET-list route all hold. However one premise citation is wrong (CORS allowedHeaders is line 67, not 71 as cited), and a substantive design gap exists in the adminfetch-header lane: headers are added to adminFetch with no described gateway-side consumer.

## Findings

### R1-F1 [blocker]

Five of six code lanes touch exafyltd/vitana-v1 exclusively, yet vitana-v1 has no pinned commit in this review session. The eight-plus premises the plan cites by exact file path and line number — useTenant.tsx:124-133, admin-api.ts:5-7 and :33-41, CommerceJoin.tsx:142/149/176, AuthGuard.tsx:271, RedeemVoucher.tsx:65-164, RedemptionLanding.tsx:44-51, store-links.ts:6/31/49, App.tsx:469, and all supabase edge functions — cannot be verified at the declared pinned commit. The gateway's own source (index.ts:562-567) confirms those edge functions live in vitana-v1, not vitana-platform: 'Aurora migration B7: Gemini-shaped facade over Bedrock, for vitana-v1 edge functions being ported off direct Google calls'. If any vitana-v1 premise is stale — wrong line numbers, AppHooksInitializer moved, C2 golden path changed, gen-tokens.mjs absent — the implementation fails silently or introduces a regression that cannot be caught at review time.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:562` — // Aurora migration B7: Gemini-shaped facade over Bedrock, for vitana-v1
    // edge functions being ported off direct Google calls (VTID-03764 chain).
    const aiBridgeRouter = require('./routes/ai-bridge').default;
    // Aurora migration B6: object-storage facade for vitana-v1 edge functions
    // that call Supabase Storage directly (VTID-03815 continuation).
    const storageBridgeRouter = require('./routes/storage-bridge').default;
- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:11` — Lane number ranges: S-M `20261013233000`; A `20261014000100`–`000300`;
B `20261014000400`–`000500`; C `20261014000600`–`000700`.

Suggestion: Pin exafyltd/vitana-v1 at the same review-time commit and re-submit. Every vitana-v1 premise must be verified with read_file before the plan is passed: useTenant.tsx token-setting block, admin-api.ts current header set, CommerceJoin/AuthGuard/RedeemVoucher/RedemptionLanding hardcoded slugs, store-links constants, App.tsx AppHooksInitializer at :469, and the existence of scripts/native/gen-tokens.mjs.

### R1-F2 [major]

The adminfetch-header lane injects X-Vitana-Tenant and X-Vitana-Active-Role into every adminFetch call but the plan names no gateway route that currently reads, routes on, or changes its response based on these headers. The CORS allowedHeaders already includes both (confirmed at cors.ts:67). Allowing a header in CORS does not cause any route to consume it. The plan has no mount-point change in services/gateway/src/routes/admin-tenants.ts or any other admin route that would start using these headers for tenant scoping. Without a named consumer the entire lane delivers dead infrastructure.

- `exafyltd/vitana-platform:services/gateway/src/middleware/cors.ts:67` — allowedHeaders: ["Authorization", "Content-Type", "apikey", "X-Vitana-Active-Role", "X-Vitana-Tenant", "X-Vitana-User", "X-User-ID"],
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-tenants.ts:51` — async function verifyExafyAdmin(
    req: Request
  ): Promise<{ ok: true; user_id: string; email: string } | { ok: false; status: number; error: string }> {
    const token = getBearerToken(req);
    if (!token) return { ok: false, status: 401, error: 'UNAUTHENTICATED' };

Suggestion: Either (a) name the specific gateway admin routes or a new middleware that will begin reading X-Vitana-Tenant to scope queries as part of this lane, demonstrating an immediate consumer, or (b) explicitly label this lane as preparatory plumbing and reference the follow-on VTID in the WS7 backlog that adds the gateway-side reads. Without that, the Vitest that pins the headers present only proves the client sends them — not that anything acts on them.

### R1-F3 [minor]

The plan cites 'gateway CORS already allows those headers (services/gateway/src/middleware/cors.ts:71)'. Line 71 is inside the VTID-02036 credentials comment block. The allowedHeaders array containing X-Vitana-Active-Role and X-Vitana-Tenant is at line 67. The underlying premise holds but the wrong line is cited, indicating the premises were not verified by reading the file at the pinned commit.

- `exafyltd/vitana-platform:services/gateway/src/middleware/cors.ts:67` — allowedHeaders: ["Authorization", "Content-Type", "apikey", "X-Vitana-Active-Role", "X-Vitana-Tenant", "X-Vitana-User", "X-User-ID"],
    // VTID-02036: REVERTED VTID-02034. With credentials:true the browser
    // requires Access-Control-Allow-Credentials on every response and
    // the SSE/EventSource path on iOS Safari interacted poorly with it.
    // Restoring credentials:false; cross-origin requests carry no cookies.
    credentials: false,

Suggestion: Correct the reference to :67. More importantly treat this discrepancy as a canary: if the one verifiable CORS line reference is wrong, the eight-plus unverifiable vitana-v1 line references (R1-F1) should be treated as suspect until confirmed against a pinned vitana-v1 commit.

### R1-F4 [minor]

The brand-surface lane's useTenantMeta() hook sets OG meta tags (og:site_name etc.) client-side via JavaScript. Standard share-card crawlers for Facebook, Slack, Twitter/X, WhatsApp, and iMessage do not execute JavaScript and read only raw HTML. The gateway already has a server-side OG/share path (publicProfileOgRouter mounted at services/gateway/src/routes/public-profile-og.ts, index.ts:194) and the email-brand-code lane addresses the OG workers directly. The useTenantMeta() OG writes are therefore ineffective for their primary purpose and will not produce per-tenant share-card branding.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:193` — // Public, auth-less profile lookup for OG/share previews (Cloudflare worker).
    const publicProfileOgRouter = require('./routes/public-profile-og').default;

Suggestion: Scope useTenantMeta() to document.title and favicon href only — both are legitimate client-side mutations. Remove OG tag mutations from its responsibility and rely entirely on the server-side OG worker lanes (email-brand-code) for share-card branding. If OG meta in the SPA HTML is still desired, add an explicit note that it only affects JS-capable crawlers and has no effect on social share cards.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
