# Plan sparring record — VTID-05022 (multi-tenant program plan)

Gate: Plan Sparring Gate (VTID-04868), gate mode `log` at allocation time. The sparring ran inside a Claude Code session using the `plan-sparring` skill's documented fallback (a read-only general-purpose agent given the `plan-sparring-partner` instructions; the repo agent type was not loaded in that session). No gateway `plan_sparring_sessions` record exists for it; the VTID was allocated with `p_plan_hash` = the final v5 plan-body hash and no `p_sparring_id`, so the log-mode gate records it as missing a sparring id.

Final plan-body hash: `869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326` (text between the plan markers in `docs/MULTI-TENANT-PLAN.md`).

Owner approval: in chat, 2026-10-10 — the owner asked for all open decisions to be answered with the planner's recommendations (recorded as the decision register in the plan) and asked for the plan to be committed.

Below: the planner's responses to every finding of every round, per plan version (each response names the finding ID it answers), and the per-version sparring summary. The partners' full verbatim outputs were not persisted as files in the session; the finding IDs, severities and outcomes are recorded here.

Before v3's partner rounds, the draft (v2) was also challenged by four expert critiques (architecture, security, delivery, product) whose recommendations were folded into v3.

---

## Plan v3


### Planner responses — round 1
Live checks run read-only by the planner for this round (2026-10-06): `has_function_privilege('authenticated', write_fact/get_current_facts/recall_at_time_range/memory_facts_semantic_search/fn_consume_credits)` = true, anon = false; `get_user_profile_by_identifier` anon = true, returns `email`; `switch_to_tenant_by_slug` live body inserts into `memberships`; `increment_wallet_balance` not executable by anon/authenticated (dropped from Track S); …0001 memory_facts = 1,067 rows, 1 distinct user = dev user …0099, 0 real members, newest 2026-07-21; …0001 chat_messages = 2 senders, 236 sent by bot user …0001, newest 2026-07-21; `notify_on_chat_message` uses …0001 as the bot sender id.

- F1 ACCEPTED — production canary and honeytokens removed; production isolation monitoring is now a read-only service-role RPC `ci_tenant_isolation_health()` in the morning health check; exit criteria rewritten (§1, §6 WS0, §7, §8).
- F2 ACCEPTED — M1 now runs on the D11 local stack; a production `mt-synthetic` tenant is owner decision D13 (default NO) with rule-44 preconditions if approved (§5, §7).
- F3 ACCEPTED — DB-slice protocol added (dry-run on local stack, pre-approved rollback, off-peak, owner apply approval, post-apply read-only verification); flags explicitly gate only code reads (§4.7, §8).
- F4 ACCEPTED — hook must fail open, single indexed lookup, short timeout; migration + owner-applied auth-config step + disable runbook + login p95/error check; shadow mismatches logged to a table as decisions; owner decision D14 (§4.2, §5).
- F5 ACCEPTED — S-E hotfix keeps self-enrolment only for `tenants.open_signup = true` (maxina, alkalma), community role, writes `user_tenants`; gateway checks membership; full join flow in WS3 (§3).
- F6 ACCEPTED — answer to Q1: yes, called anonymously (PublicProfilePage, ProfilePreviewDialog, useRealMatches); no consumer reads `email` (only declared at `PublicProfilePage.tsx:31`). Fix = strip `email`/private fields, keep anon EXECUTE, pin field list (§3 S-D).
- F7 ACCEPTED — answer to Q3: counts were on `tenant_id`; breakdown above shows the memory_facts are dev-user test data and much of the chat is bot-sent; §2 corrected (…0001 is both dev tenant and bot user; welcome/notify functions are not tenant-hardcoded); WS2 now splits by column, quarantines/deletes …0099 test data, never remaps to Maxina.
- F8 ACCEPTED — rule 41 made explicit: packs supply facts + English intents; `{{brand}}` only for UI/push/email/`tt()`; golden suite compares assembled instruction/intents and strings, not speech (§4.5, WS0).
- F9 ACCEPTED — hook claim is the single tenant source for DB, gateway (`auth-supabase-jwt.ts:273` and `:510-520` replaced) and edge functions; `active_tenant_id` demoted to an untrusted preference (§4.2).
- F10 ACCEPTED — `is_member(tenant_id)` in tenant-shared policies + session revocation on membership removal (§4.2).
- F11 ACCEPTED — "expedited" defined as the gate's expedited class (≥2 passes, time-boxed, immediate owner approval), never break-glass (§3).
- F12 ACCEPTED — `/debug/awareness` added; S-J and DEFAULT_TENANT_ID work driven by WS0 generated inventories (§3). Partial dispute on the premise: `reminders.ts:59-60` does read `req.get('X-Tenant-ID')`/`req.get('X-Vitana-Tenant')` (it uses `req.get`, not `req.headers`), so reminders stays in S-I with the line cited.
- F13 ACCEPTED — `test:support` and `test:operator` added to required suites (WS0).
- F14 ACCEPTED — config snapshot (auth hook, realtime publication, bucket policies) + read-only drift lint added to D11 (§5).
- Q2 (open self-enrolment): `tenants.open_signup` boolean, true for maxina/alkalma; new tenants default false until launch; changed only via the tenant admin API/provisioning.
- Q4 (auth hook ownership): the owner (or a named exafy_admin) applies the auth-config change in the Supabase dashboard per a runbook committed with the slice; disable = toggle the hook off in the same panel (claims fall back to today's state); D14.
- Q5 (rollback after data move): `bak_*` snapshot retained 30 days; rollback migration restores from it; dropped by a separate later migration after the 30 days with owner OK.
- Q6 (existing cross-tenant data): D15 default — rows stay in their author's primary tenant; existing cross-tenant DMs remain visible to both participants, new ones blocked under D1.
- Verdict items (a)–(d): (a) answered by F1 — no canary proposed any more; (b) = D13; (c) = D14; (d) = D12. These remain owner decisions and are listed for escalation.

### Planner responses — round 2
Live read-only checks (2026-10-06): `memberships`-only users: maxina 11, alkalma 4; `user_tenants` has unique index `user_tenants_tenant_id_user_id_key (tenant_id, user_id)`; `user_tenants` AFTER INSERT triggers: `welcome_chat_on_primary_membership`, `founding_seat_on_primary_membership`, `seed_onboarding_autopilot_on_primary_membership`, `trg_create_user_live_room`; `user_tenants` has no welcome flag column.
- N1 ACCEPTED — broadened to all four primary-membership triggers (welcome DMs, founding seat, onboarding autopilot seed, live room). Pre-hotfix DB slice backfills the 15 drifted users with triggers suppressed via a per-transaction guard and welcome marked sent; RPC uses `ON CONFLICT (tenant_id, user_id) DO NOTHING`, sets `is_primary` only when none exists; pgTAP/contract test asserts zero side effects for an already-known member (§3 S-E).
- N2 ACCEPTED — `current_tenant_id()` = verified claim, else caller's primary membership (never app_metadata); shared single lookup via initPlan `(select …)`; gateway keeps the same fallback; two runbooks (shadow / live); hook-off local-stack test (§4.2). This supersedes the round-1 Q4 wording "falls back to today's state".
- Q1 answered above (11 + 4; unique constraint exists).
- Q2: yes — one STABLE DEFINER lookup on the unique index, invoked as `(select current_tenant_id())`/`(select is_member(tenant_id))` so it is evaluated once per statement, not per row; WS0 adds an EXPLAIN-based check on the two hot tables.

### Planner responses — round 3
Live read-only check (2026-10-06): bare tenant-only policies = 56 on 28 tables (list in §2), incl. user-private health/consent tables.
- N3 ACCEPTED (planner adopts the partner's precondition, both halves): the resolver ships as a separate function `tenant_id_for_policies()`; bare policies are rewritten table by table; a WS0 bare-policy lint (must be zero, checked read-only against live) is a hard pre-apply gate before `current_tenant_id()` is redefined; pgTAP covers user-private rows on all 28 tables (§2, §4.2).
- N1 clarification ACCEPTED: welcome mark = `app_users.welcome_chat_sent = true` (§3 S-E).
- Q1: 56 policies / 28 tables; user-private ones listed in §2; the generated inventory becomes a WS0 deliverable.

### Sparring record
Partner: independent read-only plan-sparring-partner (CLAUDE.md VTID-04868 instructions; repo agent type not loaded in this session, documented fallback used). Rounds: 3 (standard cap). Round 1: 2 blockers + 7 majors + 5 minors, all accepted (one premise partly disputed and conceded by the partner). Round 2: 2 new majors (N1, N2), accepted. Round 3: 1 new major (N3), accepted by adopting the partner's precondition after the cap.
Verdict: **ESCALATED** (cap reached with N3 open at the partner's last pass; planner has since adopted the partner's exact suggestion). Owner decisions required: confirm N3 resolution; D12 parallel lanes; D13 production synthetic tenant (default NO); D14 auth-hook enablement procedure + two runbooks; D15 existing cross-tenant data; plus defaults D1–D11.

---

## Plan v4


(Prior sparring of v3: 3 rounds, all findings F1–F14, N1–N3 accepted and folded in; record kept in Vitanaland-MultiTenant-Plan-v3-sparred.md.)

### Planner responses — v4 round 1
- F1 ACCEPTED — verified in code on main (`admin-partner-health.ts:68-78`, `/orders` :129-153 has no tenant predicate). Added as Track S item S-L (remove tenant-admin branch; exafy_admin + partner-org scope only; 403 test for a T_B admin). D18 updated. Q5: the branch was deliberate in VTID-03885 ("Vitana tenant admin" operates the DoctorBox fallback UI); with Alkalma admins present it is now a cross-tenant leak, and the fallback ops role is exafy_admin.
- F2 ACCEPTED — N1 and WS9 testing moved to the D11 local stack with fixture tenants and FCM/APNs sandbox; production-facing native checks read-only; real-tenant device walkthroughs require a D13-type owner decision.
- F3 ACCEPTED — rule: health writes go to the member's home (primary) tenant until health keys are re-keyed by user with Health plan Phase 1; target = user-keyed health store, tenant_id dropped from health unique keys via expand/contract; ab_dual pgTAP (§4.9). Q1 answered there.
- F4 ACCEPTED — device tokens fetched by user_id; per-tenant copy from the notification row; ab_dual contract test (§4.8, WS6/WS9).
- F5 ACCEPTED — claim stays the only source; deep link and device tenant are inputs to `switch_active_tenant(slug)` (membership check → preference → refreshSession); minimal switch mechanism pulled into N1; join-screen test (§4.8, N1).
- F6 ACCEPTED — D19 added; default bundled SPA + OTA channel promoted only by PUBLISH; governed native release workflow; CORS/redirect/OAuth consequences listed (§4.8). Q2 answered.
- F7 ACCEPTED — M2 pilot is web-only; native surfaces excluded from the M2 string check (§7).
- F8 ACCEPTED — explicit platform context for commerce/supplier/MCP routes; new suppliers need no community; rule-45 exclusion; `partner_tenant.tenant_id` backfilled and referenced by `supplier_tenant_relationships` (§4.10). Q3 answered.
- F9 ACCEPTED — M2 uses a v1 Discover predicate only (no eligibility engine); one shared predicate for all product readers incl. cart/checkout tools, marketplace-guide/journey repos, shopping agent; generated inventory + lint (§4.10). D7 to be ticked by the owner. Q4 answered.
- F10 ACCEPTED — lineage guard (build-failing test) over health tables incl. the `vitana_index_snapshot` hook; ORB product tools never get health context (§4.9).
- F11 ACCEPTED — D12 now states real peak concurrency (≈7 sessions); one ordered migration queue file across lanes/programs; health/commerce migrations added to the estimate (§5, §8). Q7 answered.
- F12 ACCEPTED — single reconciled estimate/timeline table; N1 legal prerequisites on its dependency line; WS9 sized as Phase 5 + tenancy delta (§7, §9).
- F13 ACCEPTED — controllership split out as [LEGAL] D20; working assumption stated (§4.9, §5).
- F14 ACCEPTED — immutable store identifiers exempted; D21 asks the owner to confirm Apple team and Android signing keys. Q6 → D21.
- F15 ACCEPTED — reserved slug list from the registry enforced by `provision_tenant`; custom domains = app release (§4.8).
- F16 ACCEPTED — per-device transport flag + sunset test (§4.8).
- F17 ACCEPTED — D22 in-app payments policy (§4.8, §5).

### Planner responses — v4 round 2
- M0 exit leftover ACCEPTED — now "S-A..S-L".
- F5 note ACCEPTED — `switch_active_tenant` never self-enrols (membership check only); recorded for its sub-plan.
- N-1 ACCEPTED — frozen `app_users.health_home_tenant_id` (backfilled once, not tied to later `is_primary` changes); health tables excluded from `TENANT_TABLES`; user-keyed `healthDb(userId)` accessor; generated inventory + lint; the five named session-tenant readers/writers converted first; ab_dual-in-T_B pgTAP/contract test (§4.9). Q1 answered.
- N-2 ACCEPTED — guard scoped to the products/merchants reader inventory + tenant-analytics surfaces; health-coaching modules explicitly outside; community-autopilot = coaching, outputs never on tenant-admin surfaces; ORB session rule closes the model-mediated leak path with a tool-selection test (§4.9). Q2 answered.
- N-3 ACCEPTED — reserved non-community platform tenant row (`is_platform`), intent-branching signup triggers, `platform_only_accounts` view in the rule-45 lint (§4.10). Q3: a supplier-only user's notifications carry the platform tenant id; `handle_new_user`/`provision_platform_user` branch on `signup_intent`.
- N-4 ACCEPTED — OTA manifest `min_native_version`, shell reports version/plugins, client refuses incompatible bundles, runtime capability detection, distribution check before promotion, old-binary fixture test (§4.8). Q4 answered.

### Planner responses — v4 round 3 (after the cap)
- R3-1 ACCEPTED (partner's suggestion adopted verbatim in substance): commerce-intent gate in the dispatcher, covering `use_tool`; server-side argument validation against the current transcript; tests on Nova and the Vertex bridge (§4.9). Q1: dispatcher-level, so every handler and the `use_tool` path are covered.
- R3-2 ACCEPTED (adopted): platform tenant emitted by the hook and policy resolver for platform-only accounts, never resolved from host/slug/picker/deep link, rejected by community routes and tenant-shared RLS with a contract test; joining a community makes it primary; `signup_intent` untrusted (§4.10). Q2: the hook emits the platform tenant; community routes return 403/empty.
- N-2, N-3: closed by the two items above.

### Sparring record (v4)
Partner: independent read-only plan-sparring-partner (VTID-04868 instructions; repo agent type not loaded in this session, documented fallback). Prior: v3 sparred in 3 rounds (record in Vitanaland-MultiTenant-Plan-v3-sparred.md).
- Round 1: 2 blockers (F1 live cross-tenant lab-data access by tenant admins, F2 native testing would write to production) + 11 majors + 4 minors → all ACCEPTED.
- Round 2: F1–F17 closed/acknowledged; 4 new majors (N-1 health home tenant, N-2 lineage guard scope, N-3 platform principal, N-4 OTA compatibility) → all ACCEPTED.
- Round 3: N-1, N-4 closed; 2 new majors (R3-1 dispatcher-level commerce gate, R3-2 platform tenant resolution) → ACCEPTED after the cap by adopting the partner's own suggestions.
**Verdict: ESCALATED** (round cap reached; all findings now folded in; owner decisions listed). Owner must decide: D7/commerce D-6, D12, D13, D14, D16, D17, D18 (incl. S-L impact on DoctorBox ops), D19, D20 [LEGAL], D21, D22, and tick/override D1–D3, D5, D8–D11, D15.

---

## Plan v5


(Prior sparring: v3 3 rounds, v4 3 rounds — all findings folded in; records in the v3/v4 sparred files. v5 adds §4.11 and the D1/D15/D23 changes.)

### Planner responses — v5 round 1
Live read-only check (2026-10-10): `chat_messages` INSERT policies check only `sender_id = auth.uid()` (+ group membership for group rows); `global_thread_participants` INSERT is creator-only ("Thread creators can add participants" / "…join their own threads") — the self-join is NOT possible live.
- Premises: corrected §4.11 "Today" (Community-vs-Professional origin of the pill, desktop labels, gateway vs browser read paths disagree, `tenant_id` NOT NULL, `is_visible` default true and its five uses, network-wide matching using the Vitana Index, intent system scope, ORB pool, Discover pill = tabs). The "all current chat_messages are Maxina" claim is withdrawn; the …0001 rows go through WS2 first.
- F1 ACCEPTED (self-join part not live, verified) — client INSERT revoked on `chat_messages`/`global_messages`; SECURITY DEFINER `send_message()` derives tenant/scope and enforces visibility, preference, blocks and rate limits; pgTAP: direct PostgREST insert to a "nobody" recipient fails.
- F2 ACCEPTED — `tenant_id` = sender's tenant as context + `scope` column; community reads tenant-predicated, network participant-only; health check excludes network; push uses recipient home tenant; platform tenant never on member content. Q1 answered.
- F3 ACCEPTED — new `network_visible` default false (+ decided_at); `is_visible` unchanged; rule-45 forces false; existing members backfilled false + one-time prompt as recorded golden exception (D23); public web profile = separate scope (D24). Q3 answered.
- F4 ACCEPTED — stated as behaviour change; Vitana Index removed from matching unless D25 chooses a separate consent; matching joins the lineage guard; `match_reasons` test.
- F5 ACCEPTED — intent system's `p_visibility` reused (community ↔ tenant branch, network ↔ public branch with `network_visible`), default = caller's scope; `daily_matches` gets scope. Q2: both, via one scope.
- F6 ACCEPTED — messaging unlocks only on mutual acceptance (accepted `connection_requests` or intent mutual reveal); "connection" defined; first-contact rate limit.
- F7 ACCEPTED — ORB scope rule enforced in send handler + `resolve_recipient_candidates` scope parameter; covers find_community_member/superlatives/global_search; Nova + Vertex tests. Q5 answered.
- F8 ACCEPTED — thread key `(scope, tenant-if-community, peer)`; one migration rule cited by D15; …0001 via WS2 first; `global_message_threads`/`global_messages` frozen then migrated to `chat_groups`.
- F9 ACCEPTED — `products.distribution` default `community`; tenant hides apply in both modes; revenue-share split = D26. Q4: yes, hides apply in Network mode within that tenant's app.
- F10 ACCEPTED — re-estimated (+14 PRs, +6 VTIDs, +14 session-days); Network surfaces ship behind `mt.network_enabled`; Network moderation is a staffed Exafy ops line from M2. Q6: Exafy, staffed, outside engineering totals.
- F11 ACCEPTED — separate scope control in Discover.
- F12 ACCEPTED — professional↔patient messaging = Community role-gated threads; role routing removed.
- F13 ACCEPTED — per-surface field allowlists in contract tests.

### Planner responses — v5 round 2
Live read-only check (2026-10-10): `connection_requests` policies = INSERT `auth.uid() = from_user_id`, UPDATE by recipient, SELECT by either party; no triggers → `status` is not protected (Q1: live matches the repo; F14 confirmed). The `global_thread_participants` drift between live (creator-only) and repo (self-join) is recorded for the D11 config snapshot/lint.
- F14 ACCEPTED — `connection_requests` brought under DEFINER `request_connection()`/`respond_connection()`; only the recipient accepts; Network preconditions, block, rate limit; message capped/dropped for Network; intent mutual reveal reviewed; pgTAP for self-accept and "nobody".
- F15 ACCEPTED, option (a) proposed as D27 — limited Network groups (≤20, invite-only between connections, scope columns, context-only tenant_id, participant RLS, no fan-out, Exafy moderation, isolation suite, estimate); option (b) archive stated as the fallback if the owner declines. Q2 answered.
- F16 ACCEPTED — `scope` expand/contract with temporary default; `send_message()` binds sender to `auth.uid()`, called with the user JWT; scope validation rules; writer inventory + lint with an allowlist of system writers each covered by pgTAP; gateway `/send` rewritten. Q3 answered.

### Planner responses — v5 round 3 (after the cap)
- F17 ACCEPTED (partner's suggestion adopted): service-role-only `send_message_as()` sharing the `send_message()` check body, sender from verified gateway/ORB identity only; the five member-originated writers routed through it; `add_group_member()` for Network groups; allowlist narrowed to true system writers writing `scope='community'`; pgTAP/contract tests for voice send and intent share. Q1: yes.
- F16 remainder: closed by F17.

### Sparring record (v5)
Partner: independent read-only plan-sparring-partner (VTID-04868 instructions; documented fallback). Prior: v3 (3 rounds) and v4 (3 rounds), all findings folded in.
- Round 1: 1 blocker (F1 client-side DM inserts bypass any preference/block — confirmed live; the self-join half was not live) + 9 majors + 3 minors → all ACCEPTED; §4.11 "Today" corrected (the existing pill is a Community-vs-Professional split; matching is already network-wide and uses the Vitana Index).
- Round 2: F1–F13 closed; 1 new blocker (F14 self-grantable connections — confirmed live) + 2 majors (F15 Network groups, F16 writer inventory) → ACCEPTED.
- Round 3: F14, F15 closed; F17 (five member-originated service-role writers) → ACCEPTED after the cap by adopting the partner's own fix.
**Verdict: ESCALATED** (round cap). Owner decisions for v5: D23 [LEGAL with D20], D24, D25, D26, D27, D20 [LEGAL]; plus all open decisions carried from v4 (D7, D12, D13, D14, D16, D17, D18, D19, D21, D22) and the defaults D2, D3, D5, D8–D11, D15.

