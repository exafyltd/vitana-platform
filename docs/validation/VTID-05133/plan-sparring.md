# VTID-05133 — Plan sparring record

Plan hash (sha256 of the text between the plan markers): `81589790db61d31257b3725447a283f51a804877040e15b60bb9cd8d03f93b95`. Partner: plan-sparring-partner (read-only, independent). Class: standard. Rounds 1–2 CONVERGED before Gate 1; owner approved in session 2026-10-13 ("Yes"). Mid-flight amendments A1 (ChatGPT path after VTID-04990) and A2 (premises that failed against the live database) each went back to the same partner for one round: both CONVERGED. The gate is in log mode; the session is recorded here and in the ledger row (VTID-05133 metadata.sparring_record, plan_hash).

# Plan — "Connect your AI": Maxina Community MCP for ChatGPT and Claude

<!-- plan:begin -->

## Change class
**standard** — new gateway route + service, a migration, OAuth consent UI, member privacy setting, staging tests. Two repos.

## Goal
A Maxina member connects ChatGPT or Claude to their Maxina account and their AI can then (read-only, v1) see their own Maxina profile/goals, their matches and recommended connections, find people who opted in, and find activities. One Maxina-side consent screen with per-category permissions; revocable from Maxina. Health/Vitana memory data is NOT exposed in this plan.

## Owner decisions already taken (2026-10-08, chat)
- Reuse the Commerce MCP stack (gateway-hosted, Supabase Auth OAuth 2.1 server, client allowlist, delegation guard). Do not build on `services/vcaop-mcp` (in-memory OAuth state).
- Separate Community MCP endpoint, not new tools on Commerce.
- v1 read-only. No health / memory data. `find_people` returns only members who opted in.
- Directory listing (ChatGPT App Directory, Anthropic Connectors Directory) is a later phase.

## Verified facts the design rests on
- `routes/commerce-mcp.ts`: POST `/mcp`, hand-written JSON-RPC in `services/commerce-mcp.ts` (`handleJsonRpc` :723, `auditToolCall` :680), RFC 9728 metadata at `/.well-known/oauth-protected-resource[/mcp]`, scopes `email profile` (no `openid`, VTID-04882), 120 calls/min/user in memory.
- `services/mcp-client-allowlist.ts` `checkMcpClient()` — identifies the assistant by the client's registered redirect hosts (`mcp_oauth_client_info` RPC).
- `services/delegation-guard.ts` `isDelegatedPathAllowed()` already admits `/mcp/*`, so `/mcp/community` needs no guard change.
- Supabase access tokens are **not audience-bound per resource**: a token issued to a Commerce connector would be accepted by any `/mcp/*` endpoint. Per-resource permission must therefore be enforced by Vitana, keyed on the token's `client_id` claim.
- Supabase's OAuth server has **one** consent ("authorization") path per project — today `/commerce/connect/authorize` (`vitana-v1 src/pages/CommerceConnectAuthorize.tsx`, `src/lib/commerce-mcp.ts` `CONNECT_AUTHORIZE_PATH`). Its authorization details expose client, redirect_uri and scope; whether they expose the requested `resource` is unverified (see Spike S1). The consent screen therefore cannot assume which Vitana product is being connected.
- Backing logic exists: `findCommunityMember()` (`services/voice-tools/community-member-ranker.ts`, already excludes test/service accounts), `dispatchOrbTool('search_events' | 'search_community', …)` (`services/orb-tools-shared`), `match_get_daily` RPC (user-JWT, `routes/matchmaking.ts:350`), relationship RPCs (`routes/relationships.ts:716`), `/api/v1/me` + `profile-prefs.ts` + `life-stage-awareness.ts` goals.
- `fetchExcludedTestServiceAccountIds()` (`lib/excluded-test-service-accounts.ts`) is the single exclusion helper (P/CLAUDE.md rule 45).

## Design

### 1. Gateway: `/mcp/community` (vitana-platform)
- New `routes/community-mcp.ts` mounted at `/mcp/community`, plus metadata at `/.well-known/oauth-protected-resource/mcp/community` (resource `${origin}/mcp/community`, `resource_name: 'Maxina Community'`, same authorization server and scopes as Commerce).
- Flag `COMMUNITY_MCP_ENABLED` (exact `'true'`, else 404), independent of `COMMERCE_MCP_ENABLED`. Set `true` on staging task def only; production stays off until Gate 2 + a separate flip.
- Extract the shared transport pieces from `commerce-mcp.ts` (bearer parse, `unauthorized()` with `WWW-Authenticate`, `publicOrigin`, rate limiter, client check, JSON-RPC envelope, batch handling) into `services/mcp/mcp-http-core.ts`; Commerce keeps byte-identical behaviour (existing Commerce tests must stay green unchanged). New `services/community-mcp.ts` supplies the tool list + handlers.
- Every call: verify token → `checkMcpClient` (same allowlist) → **require a grant** (section 3) for `(user_id, client_id)` with the category the tool needs → run tool → `auditToolCall`-equivalent OASIS event `community.mcp.tool_called` (tool name, client_id, result size; no argument text containing other members' data).
- A token with no `client_id` (member's own session) is refused on `/mcp/community` (the connector is for assistants only).
- Mount order: `/mcp/community` is mounted in `index.ts` BEFORE Commerce's `/mcp`. One well-known router (built from a factory in `mcp-http-core.ts`) serves the metadata for both resources: `/oauth-protected-resource`, `/oauth-protected-resource/mcp` (Commerce, unchanged) and `/oauth-protected-resource/mcp/community`.
- **Commerce becomes grant-aware without breaking existing suppliers:** `/mcp` refuses a `(user_id, client_id)` that HAS a grant row without the `commerce` category. A client with NO grant row (every connection made before this ships) keeps working exactly as today. So a Community-only approval can never reach Commerce tools, and nothing existing breaks.

### 2. v1 tools (all `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`)
| Tool | Category needed | Backed by | Output limits |
|---|---|---|---|
| `get_my_maxina_profile` | `profile` | `/me` service logic, `profile_prefs`, life-stage goals | own data; no health fields, no email/phone |
| `get_my_matches` | `matches` | the repository function behind `GET /match/daily` (`repo.getDailyMatchesRpc`, `match_get_daily`) called with a `createUserSupabaseClient(delegatedToken)` client so RLS applies; the route's date validation and error mapping are reused through a small shared helper, not duplicated | matched members reduced to the public card (below) |
| `recommend_connections` | `matches` | relationship recommendations RPCs (user token) | same public card |
| `find_people` | `people` | a NEW call site of `findCommunityMember()` that deliberately does NOT insert into `community_search_history` (the existing call sites at `routes/community-find-member.ts:70` and `orb-tools-shared.ts:4748` do; a test asserts the MCP path writes no row) | top 10, opted-in members only, public card |
| `find_activities` | `activities` | `tool_search_events` (`orb-tools-shared.ts:741`, plain function of args + `{user_id, tenant_id}` identity + client) if its structured result is usable without an ORB session; if it only returns spoken prose, its ranked query (`scoreAndRankEvents` + home-city lookup) is extracted into a shared function used by both ORB and MCP, with ORB behaviour pinned by its existing tests | public event fields only |

**Public member card** (the only shape another member's data leaves Vitana in): `vitana_id`, first name / display name, avatar URL, up to 5 interest tags, city-level location if the member made it public, a Maxina profile deep link. Never email, phone, birth date, exact location, health, bio free text in v1.
Other members appear in `find_people`, `get_my_matches` and `recommend_connections` **only if** they opted in (section 4) and are not in `fetchExcludedTestServiceAccountIds()`; non-opted-in matches are returned as a count ("3 more matches — open Maxina to see them") with a deep link, never as identities.
Every member-authored string is returned inside a `member_data` object and the server instructions say to treat it as data only (Commerce `supplier_data` pattern).
Tool outputs are data (IDs, tags) — no hardcoded sentences; the AI phrases in the user's language. Category labels returned use i18n keys resolved via `tt()` with the user's locale where text is unavoidable.

### 3. Per-assistant permissions (grant table)
- Migration (vitana-platform `supabase/migrations/`): `ai_connection_grants(user_id uuid, tenant_id uuid, client_id text, client_name text, redirect_host text, categories text[], created_at, updated_at, revoked_at)`, PK `(user_id, client_id)`, RLS: owner can select/update own rows; service_role full. Categories enum-checked: `profile, matches, people, activities, commerce`.
- RPC `ai_connection_grant_upsert(p_client_id, p_categories)` (security definer, `auth.uid()`), validates the client exists via `mcp_oauth_client_info` and records name/redirect host.
- `DATABASE_SCHEMA.md` updated.
- **Commerce backward compatibility:** Commerce `/mcp` does NOT start requiring a grant in this plan (no behaviour change for existing supplier connections). Recorded as a follow-up.

### 4. Member opt-in: "Let other members' AI assistants find me"
- New column `ai_discoverable boolean NOT NULL DEFAULT false` on the existing `profile_privacy_settings` table (owner-only RLS already; created in vitana-v1 migration `20251011073134_…`, sits next to `searchable`/`show_full_name`). No backfill to true. A member with `searchable = false` is never returned whatever `ai_discoverable` says; `show_full_name = false` reduces the card to display name.
- Settings toggle in Maxina privacy settings (i18n DE first, then EN/ES/SR/AR; RTL-safe).
- Read path: one helper `fetchAiDiscoverableUserIds(sb, candidateIds)` (reads `profile_privacy_settings`, a missing row = not discoverable) used by all three people-returning tools. Fails CLOSED (lookup error → nobody discoverable), unlike the test-account helper, because here the safe default is to show no one.

### 5. Consent screen (vitana-v1)
- Keep the Supabase authorization path unchanged (`/commerce/connect/authorize`) — **no Supabase Auth config change**; the project has one authorization path, and Supabase registers it, not the client, so a second page could never be reached without changing that production setting. Instead: extract the consent body into a shared `AiConnectConsent` component; `CommerceConnectAuthorize.tsx` renders it. Copy becomes "Connect {client} to your Maxina account" with a neutral shell for members, and the supplier wording stays inside the Supplier-tools section. Existing tests (`connect-authorize.vtid-04970.test.ts`, `commerce-mcp.test.ts`) keep their assertions on the approve/deny/redirect-host behaviour; only copy assertions are updated, and a new test pins that a supplier sees and keeps the Supplier-tools permission on by default.
- Permission list with toggles: Profile, Matches & recommendations, Find people, Activities (default on); "Supplier tools" toggle shown only when the user has a partner organization (default on for them, preserving today's Commerce consent). Health/memory shown as a disabled line "Not shared" (sets expectations).
- On Approve: `ai_connection_grant_upsert(client_id, categories)` FIRST, then Supabase approve; if the grant write fails, do not approve (fail closed, show error). On Deny: Supabase deny only.
- `client_id` taken from the authorization details' client object (Spike S1 confirms field name).
- Already-approved clients (Supabase returns `redirect_url` directly) skip the screen as today; a missing grant row then makes the tool return a `permission_needed` result with the Settings deep link.

### 6. Settings → Connected AI (vitana-v1)
- New section in `src/pages/settings/ConnectedApps.tsx` (`/connectors`): lists the user's `ai_connection_grants` rows (assistant name, redirect host, connected date, categories as toggles) with **Disconnect**.
- Disconnect = set `revoked_at` + clear categories (tools refuse immediately) AND revoke the Supabase OAuth grant via the Supabase Auth user-grants API if available (Spike S2); if unavailable, the Vitana-side revoke is the effective control and the UI says so.
- "Connect ChatGPT" / "Connect Claude" buttons: in this plan they open an in-app sheet with the 3-step manual instructions + copy-URL for `/mcp/community` (same pattern as Commerce's manual connect); buttons switch to directory deep links via build env vars (`VITE_CHATGPT_COMMUNITY_APP_URL`, `VITE_CLAUDE_COMMUNITY_CONNECTOR_URL`, host-validated like `chatgptPluginUrl()`) once listings exist. Button is hidden while `/.well-known/oauth-protected-resource/mcp/community` 404s.
- Rename/clarify the existing "AI assistants (API key)" card so it is not confused with this feature (copy-only change).
- What's New entry `src/whats-new/entries/connect-your-ai.json` (EN + DE du-form) — ships with the PR, surfaces only once prod is live.

### 7. Spikes (done first, on staging, read-only)
- S1: confirm Supabase authorization-details payload carries `client.client_id` (and whether `resource` is present). If `client_id` absent → fall back to looking up the client by `redirect_uri` + name via a service RPC; plan unchanged otherwise.
- S2: confirm Supabase Auth exposes listing/revoking a user's OAuth grants. Determines Disconnect wording only.

## Out of scope (later phases, each its own sparred plan)
- Phase 1: ChatGPT App Directory + Anthropic Connectors Directory submissions; real one-click buttons.
- Phase 2: `get_my_vitana_context` with a separate explicit health/memory consent (`data_sharing_consents`).
- Phase 3: write tools (post drafts via a new gateway endpoint, never direct publish; connection/follow requests) with in-Maxina confirmation.
- Commerce `/mcp` requiring a grant row.

## Files in scope
vitana-platform:
- `services/gateway/src/routes/community-mcp.ts` (new), `services/gateway/src/services/community-mcp.ts` (new), `services/gateway/src/services/mcp/mcp-http-core.ts` (new, extracted), `services/gateway/src/routes/commerce-mcp.ts` + `services/gateway/src/services/commerce-mcp.ts` (refactor to the core, no behaviour change), `services/gateway/src/index.ts` (mount), `services/gateway/src/lib/ai-discoverable.ts` (new), `services/gateway/src/i18n/catalog.ts` (if keys needed)
- `supabase/migrations/<ts>_vtid_xxxxx_ai_connection_grants.sql`; `DATABASE_SCHEMA.md`
- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` (add `COMMUNITY_MCP_ENABLED=true` to staging only)
- tests under `services/gateway/test/`
- `docs/validation/<VTID>/plan-sparring.md`, `docs/validation/<VTID>/staging-tests.json`
vitana-v1:
- `supabase/migrations/<ts>_vtid_xxxxx_ai_discoverable.sql` (column on `profile_privacy_settings`, kept in the repo that created the table),
- `src/pages/CommerceConnectAuthorize.tsx`, `src/lib/commerce-mcp.ts` (consent helpers → neutral), new `src/lib/ai-connections.ts`, `src/pages/settings/ConnectedApps.tsx` (+ mobile view), privacy settings toggle component, `src/i18n/{de,en,es,sr,ar}/*.json`, `src/whats-new/entries/connect-your-ai.json`, `docs/SCREEN_INVENTORY.md` (regenerated), `src/navigation/registry/screens.json` (check `/connectors` entries; add the Connected AI section phrasing if deep-linked, else no change), Playwright staging spec, `docs/validation/<VTID>/…`

## Test plan
CI (Jest, gateway):
1. Community MCP protocol: initialize / tools/list / tools/call; 401 + `WWW-Authenticate` without token; 404 when flag off; 405 for GET.
2. Client allowlist reused: non-approved redirect host → 403; no `client_id` → refused.
3. Grant enforcement: no grant row → `permission_needed`; revoked → refused; category missing → that tool refused, others work. Commerce-only grant cannot call community tools; Community-only grant (row without `commerce`) is refused on `/mcp`; no-row client still works on `/mcp` (legacy).
3b. `find_people` via MCP inserts no `community_search_history` row.
3c. `fetchAiDiscoverableUserIds` fails closed; `searchable=false` overrides `ai_discoverable=true`.
4. Privacy: non-opted-in members never appear by identity in any people tool (count only); test/service accounts excluded; public card contains only the allowed fields (snapshot of keys); no health fields in `get_my_maxina_profile`.
5. Commerce regression: all existing Commerce MCP tests pass unchanged after the core extraction.
6. Audit event emitted per call without other members' data.
7. Grant RPC: owner-only, enum-checked categories, unknown client rejected.
CI (Vitest, frontend): consent page renders categories, fails closed when grant write fails, Supplier-tools toggle only for partner users; Connected AI list + disconnect; opt-in toggle; i18n keys present in all locales.
Staging (read-only, STAGING-VERIFY): GET `/.well-known/oauth-protected-resource/mcp/community` → JSON with correct resource; POST `/mcp/community` without token → 401 with `WWW-Authenticate`; Playwright as the test user: `/connectors` shows the Connected AI section, consent page with a bogus `authorization_id` shows the invalid state; privacy settings shows the opt-in toggle (not clicked — no writes).
Manual, staging, by the owner (not automated, writes): connect Claude custom connector to the staging URL, approve, call each tool; disconnect. Delivered as a checklist; Claude does not perform it.

## Rollout
Merge → staging (flag on) → STAGING-VERIFY → Gate 2. Production deploy ships code with `COMMUNITY_MCP_ENABLED` unset (inert); turning it on in prod is a separate owner-approved env flip after the owner's manual staging check.
<!-- plan:end -->


---
## Planner responses — round 1
- F1 [major] ACCEPTED. `profile_prefs` was wrong. The opt-in is now `profile_privacy_settings.ai_discoverable` (default false), honouring `searchable` and `show_full_name`; helper fails closed.
- F2 [major] ACCEPTED (variant of option a). Commerce becomes grant-aware in this plan: a client WITH a grant row lacking `commerce` is refused on `/mcp`; clients with no row (all existing connections) are unchanged. Tests added.
- F3 [major] ACCEPTED. `find_people` is a new call site with no history insert; test 3b.
- F4 [minor] ACCEPTED. Community mounted before Commerce.
- F5 [minor] ACCEPTED. Single well-known router from a factory in `mcp-http-core.ts`.
- F6 [minor] PARTIALLY REJECTED. A new `/connect/authorize` page cannot be reached: Supabase Auth has one authorization path per project, set in the production Auth config, and the client cannot choose it. Changing it is a production config write outside this plan. Accepted part: the consent body is extracted into a shared component, existing Commerce behaviour tests stay, supplier default pinned by a new test.
- F7 [minor] ACCEPTED. `screens.json` added to scope.
- F8 [minor] ACCEPTED. `tool_search_events` is a plain function of args + identity + client (`orb-tools-shared.ts:741`); if its result is prose only, the ranked query is extracted into a shared function with ORB pinned by existing tests.
- Q1: `profile_privacy_settings` (see F1). Q2: see F2, Commerce now honours the grant when one exists. Q3: see F8.

## Round 2 — partner verdict: CONVERGED
F1–F5, F7, F8 closed; F6 acknowledged (single Supabase authorization path confirmed). Partner's side note (not a finding): keep the `ai_discoverable` migration in vitana-v1, the repo that created `profile_privacy_settings`. Applied.

## Owner approval (Gate 1)
APPROVED by the owner in Claude Code session https://claude.ai/code/session_014iLoqFBu5V5FKFHKgrhxeb on 2026-10-13. Plan hash sha256 81589790db61d31257b3725447a283f51a804877040e15b60bb9cd8d03f93b95. Verdict: CONVERGED (2 rounds, standard class).

---
## Amendment A1 — ChatGPT sign-in path (mid-flight, 2026-10-13)
<!-- amendment-a1:begin -->
**Why:** after Gate 1, main gained VTID-04990 (#3964, merged 2026-10-08). ChatGPT requests Supabase's full scope list including `openid`; Supabase cannot sign the ID token (HS256 key), so ChatGPT's token exchange fails with 500. Commerce now serves a ChatGPT-only path `POST /mcp/chatgpt` whose resource metadata (`/.well-known/oauth-protected-resource/mcp/chatgpt`) names the gateway itself as authorization server, and an RFC 8414 shim `/.well-known/oauth-authorization-server` advertising only `email profile` (all endpoints remain Supabase's). On that path only, loopback redirects (ChatGPT desktop) are approved and audited (`checkMcpClient(..., { allowLoopback })`). Claude's `/mcp` is byte-for-byte unchanged. Both gated by `COMMERCE_MCP_ENABLED` + `COMMERCE_MCP_CHATGPT`.
Without the same treatment, `/mcp/community` works in Claude and fails in ChatGPT — half the goal.

**Change to the plan (mirror the proven pattern exactly, nothing new invented):**
1. Two Community paths, same tools, same grant checks:
   - `POST /mcp/community` — Claude; resource metadata `/.well-known/oauth-protected-resource/mcp/community` → Supabase as authorization server (as Commerce `/mcp`). No loopback.
   - `POST /mcp/community/chatgpt` — ChatGPT; resource metadata `/.well-known/oauth-protected-resource/mcp/community/chatgpt` → the gateway origin (the existing shim). Loopback redirects approved and audited on this path only (`community.mcp.loopback_client_approved`).
2. The existing shim `/.well-known/oauth-authorization-server` is served when **either** the Commerce ChatGPT path is enabled **or** the Community ChatGPT path is enabled (`COMMUNITY_MCP_ENABLED` + `COMMUNITY_MCP_CHATGPT`, both exact `'true'`). Its content does not change. Commerce gating of its own paths does not change.
3. The extracted `mcp-http-core.ts` carries the `chatgpt` variant (metadata target, loopback flag, `WWW-Authenticate` metadata URL) so both products share one implementation; Commerce behaviour stays pinned by its existing tests, including VTID-04990's.
4. Staging pins `COMMUNITY_MCP_CHATGPT=true` alongside `COMMUNITY_MCP_ENABLED=true` (and `conversation-flag-pins.generated.ts` regenerated, as VTID-04990 had to); production off.
5. Settings "Connect ChatGPT" instructions show the `/mcp/community/chatgpt` URL; "Connect Claude" shows `/mcp/community`.

**Added tests:** both Community paths 404 when their flags are off; ChatGPT-path metadata names the gateway as AS; loopback client accepted on `/mcp/community/chatgpt` and refused on `/mcp/community`; shim served when only Community ChatGPT is on, when only Commerce ChatGPT is on, 404 when neither; all VTID-04990 tests unchanged.
**Staging (read-only):** GET both Community metadata documents and the shim; POST both paths without a token → 401 with the right `resource_metadata` URL.
**Files added to scope:** `services/gateway/src/services/conversation/conversation-flag-pins.generated.ts` (regenerated); the rest were already in scope.
<!-- amendment-a1:end -->

## Round 3 (mid-flight, Amendment A1) — partner verdict: CONVERGED
Premises of A1 verified against current main (commerce-mcp.ts shim gating :166-167, `mcpPost(chatgpt)`, `allowLoopback`, flag pins file, index.ts mounts :1231-1232). VTID-05032's ConnectedApps.tsx change does not invalidate any premise. F9 [minor] wrong path for the flag-pins file — ACCEPTED, fixed in A1. Amendment hash e0541a17800f88d30e2bb33d0ce920cd267a513eea1aee91dd9d95c2ab469628 (before the F9 path fix).

---
## Amendment A2 — premises that failed against the live database (mid-flight, 2026-10-13)
<!-- amendment-a2:begin -->
Verified read-only against production metadata (information_schema / pg_proc / aggregate counts, no row content):

1. **`match_get_daily` RPC does not exist** (pg_proc has no such function; `GET /match/daily` answers 503 today). What members actually see as matches is the `daily_matches` table (~1.7k rows; `user_id, matched_user_id, match_score, match_reasons, expires_at, action`), read directly by the app (`vitana-v1 src/hooks/useRealMatches.ts`).
   → `get_my_matches` reads `daily_matches` for the caller only (unexpired, `action IS NULL`, by score, max 20), with a service-role client filtered on `user_id = caller`. `match_reasons` codes `similar_index` and `shared_pillar` are **Vitana Index / health-derived** and legacy free-text reasons are unknown content: both are dropped. Only the codes `mutual_connections` and `active_member` pass, plus `shared_interests` computed from the two members' public interest tags.
2. **`relationship_get_signals` / `relationship_get_graph` do not exist**, `community_recommendations` is empty. `recommend_connections` has no backing engine.
   → **`recommend_connections` is dropped from v1.** Maxina's own recommendation engine is `daily_matches`; `get_my_matches` is described to the assistant as "the people Maxina recommends you meet". v1 = 4 tools.
3. **`findCommunityMember()` returns one winner and can rank on Vitana Index pillars** ("fittest", "best sleeper"…), i.e. health-derived. Exposing its winner to an outside AI would leak health-derived signal about the opted-in member.
   → `find_people` does **not** use the ranker. It ranks only opted-in members (`profile_privacy_settings.ai_discoverable AND searchable`, `global_community_profiles.is_visible` not false, same tenant, not self, not test/service accounts) by overlap of the query's words with their public interest tags (`global_community_profiles.interests`), display name and public city; top 10. No `community_search_history` write (F3 still holds trivially).
4. **Public card fields are taken from the member's own visibility settings** (`profiles.account_visibility`): `city` only when `city = 'public'`, avatar unless `avatarUrl = 'private'`; name = `display_name` (never first/last/full name); interests = up to 5 from `global_community_profiles.interests`.
5. **Spike S1 outcome:** `auth.oauth_authorizations` carries `authorization_id`, `client_id` and `resource` (populated: `…/mcp/chatgpt`, `…/mcp` seen), `user_id` is NULL while pending. → The consent screen does not trust a client-supplied id: two SECURITY DEFINER RPCs resolve the client from the pending authorization (`ai_connection_authorization_info`, `ai_connection_grant_from_authorization`), and `resource` tells the screen whether Community or Commerce asked (unknown → show both sections, supplier toggle only for partners).
6. **Spike S2 outcome:** no supported Supabase API to revoke a user's OAuth grant from Vitana. → Disconnect is Vitana-side (`ai_connection_grant_revoke`: categories emptied, `revoked_at`), effective immediately on every tool, Commerce included (a row without `commerce` refuses Commerce). The Settings copy says the assistant can no longer use Maxina and that the member may also remove it in ChatGPT/Claude.
7. **What's New entry deferred:** the repo rule tightened on 2026-10-08 ("no entry for anything partial — behind a flag"). Production ships with `COMMUNITY_MCP_ENABLED` off, so the entry is added in the PR that switches production on.
8. **`life_stage_goals` is empty in production** — `get_my_maxina_profile` still returns goals from it (explicit, active only; category containing `health` excluded) so it works once goals exist; today it returns an empty list.
9. **`find_activities`** uses `tool_search_events` (`orb-tools-shared.ts:741`), which returns structured `best/alternatives` without an ORB session; only id, title, start/end time, public location text, virtual yes/no and a Maxina deep link are returned.

Tests change accordingly: no recommend_connections tests; daily_matches reason-code allowlist test (similar_index / shared_pillar / legacy strings never appear); find_people never calls the ranker; consent RPC resolves client from authorization and rejects non-pending / foreign authorizations.
<!-- amendment-a2:end -->

## Round 4 (mid-flight, Amendment A2) — partner verdict: CONVERGED
Every A2 claim checked against code (matchmaking-repository.ts:23 + 503 guard matchmaking.ts:389-395, AURORA-B3 dead-RPC audit lists match_get_daily; relationships.ts:737-757 not-found guards; ranker single winner + pillar ranking community-member-ranker.ts:951-954; tool_search_events structured best/alternatives). Consent RPCs reviewed: client resolved from auth.oauth_authorizations, grant always written for auth.uid(), search_path pinned, helpers revoked, self-check present — no privilege escalation. No blocker, no major.
