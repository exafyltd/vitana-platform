# Design — Community isolation (WS3 Community part) — mt-community-isolation-r2 (re-plan)

## What exists (read these, do not copy them)
- Program plan + decisions: `docs/MULTI-TENANT-PLAN.md` §4.11 / §6 WS3.
- Migration order, lane ranges, apply status: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Done M0 records: `docs/validation/VTID-0514{7,9}/**`, `docs/validation/VTID-0515{0,1}/**`,
  `docs/multitenancy/LANE-C.md`.
- Community read surfaces (today — scope by `is_visible` + rule-45 exclusion, no tenant filter):
  - `services/gateway/src/services/voice-tools/community-member-ranker.ts:265-281` (candidate pool),
    `community-member-ranker-repository.ts:20-22` (`fetchVisibleProfileUserIds`).
  - `services/gateway/src/routes/community-members.ts:98-128` + `community-members-repository.ts:24-26`.
  - `services/gateway/src/services/voice-tools/superlatives.ts:10-18`, `superlatives-repository.ts:21-23`.
  - `services/gateway/src/services/orb-tools/discovery-tools.ts` (`tool_global_search`).
  - `services/gateway/src/routes/users-resolve.ts` → `resolve_recipient_candidates` (peer-scoped to
    the actor's tenant already; community branch here).
  - `services/gateway/src/services/automation-handlers/connect-people.ts` (+ `-repository.ts`).
  - Social-memory resolver: `social-memory-service.ts`, `social-context-builder.ts`,
    `person-context-builder.ts` pass `input.tenant_id` into `social-memory-repository.ts`
    (`.eq('tenant_id', …)` at :259,:337,:378,:612,:710) — the value is session-derived, not a verified
    active-tenant membership.
- Founding pool (today — one global pool of 1000): `services/gateway/src/routes/billing-repository.ts:141`
  (`FOUNDING_MAX_SEATS = 1000`, `countFoundingSeats` over `founding_members`, no tenant filter);
  `routes/billing.ts:668-775` (`/founding-status`, `/founding/me`, `/founding/celebrated`). Seats are
  granted by the DB `claim_founding_seat` on the `user_tenants` membership trigger.
- Daily matches (today — cross-tenant pool, no tenant column):
  `vitana-v1/supabase/functions/generate-daily-matches/index.ts:110-153`.
- Platform tenant (`tenants.is_platform = true`): created by VTID-05149 — the basis of
  `platform_only_accounts`.
- Rule-45 exclusion sets: `service_bot_accounts`, `notification_test_actors`
  (`services/gateway/test/lib/excluded-test-service-accounts.test.ts`,
  `services/gateway/src/.../fetchExcludedTestServiceAccountIds`).

## Design per lane
- **community-tenant-db.** Target tables are `profile_posts`, the four `global_community_*`
  (`global_community_profiles`, `global_community_groups`, `global_community_events`,
  `global_community_group_members`), `media_uploads`, `community_live_streams`, `calendar_events`,
  `content_reports`, `feedback_tickets`, `daily_matches`. Expand/contract per program plan §4.7:
  nullable `tenant_id` + FK → BEFORE INSERT trigger filling from the actor's resolved tenant → batched
  membership-join backfill (`bak_*` snapshot first) → `CHECK … NOT VALID` → `VALIDATE`; stop there (WS2
  does `SET NOT NULL`). These tables already have RLS **enabled** with permissive policies, so this
  lane **rewrites** those policies (it does not newly enable RLS), classified user-private /
  tenant-shared (`is_member`) / admin-only (`is_tenant_admin`); realtime predicate added. For
  `content_reports` the rewrite is `tenant_id` + base RLS only — mt-tenant-admin's
  `moderator-tenant-scope-db` (`070600`) layers moderation policies on top (O4). Version range
  `20261102060000–065959`. The policy-rewrite migration is NOT flag-gated (see Rule 2); its
  MIGRATION-QUEUE row goes strictly after the WS1 resolver/membership rows and after this lane's own
  backfill. Each migration has a rollback file and read-only pre/post checks.
- **founding-pool-tenant-db.** `founding_members.tenant_id` and `claim_founding_seat(p_user_id,
  p_tenant_id)` already exist (VTID-04859, `20261003100000_*.sql`), so **no column add, no `tenant_id`
  backfill** — the lane makes the cap and seat numbering per tenant: per-tenant seat sequence (replace
  table-wide `max(seat_number)+1`), `UNIQUE (tenant_id, seat_number)` + per-tenant cap check (replace
  the global `UNIQUE`/`CHECK (seat_number BETWEEN 1 AND 1000)`), `v_max_seats` as a per-tenant cap.
  Verify `tenant_id` is already populated; snapshot `bak_founding_members` + rollback. Version
  `20261102061*`.
- **platform-only-accounts-db (M2 / O5).** `platform_only_accounts` view at the pinned C3 version
  `20261102070160`; added to the rule-45 lint. A view is read-only (no expand/contract); QUEUE row +
  drift-baseline entry (removed after apply).
- **community-scope-gateway (dark).** One shared active-tenant filter from `TenantContext.tenantId`
  (WS1), applied to every reader above via a membership join; a lint bans a visibility-only community
  read. The social-memory resolver reads the active tenant from `TenantContext`, never an argument.
  Founding reporting (`countFoundingSeats`/`/founding-status`) scoped to the viewer's tenant
  (read-only).
- **community-matches-v1 (dark, vitana-v1).** `generate-daily-matches` pool scoped to the active
  tenant; `daily_matches.tenant_id` written on insert; rule-45 exclusion kept.

## Rules every successor follows
1. **Migrations:** apply strictly in `MIGRATION-QUEUE.md` order, one `RUN-MIGRATION.yml` dispatch per
   file, by Kiro only after the owner approves the files and the target database (§7d), with read-only pre/post checks. New migrations take the next version in the
   lane's range; **the `platform_only_accounts` migration is pinned to `20261102070160`** (cross-spec
   C3 — never renumber). A PR adding a not-yet-live object adds it to
   `scripts/ci/migration-drift-baseline.json` and removes it after apply.
2. **The flag gates only the read path, NOT the RLS policy rewrite.** Every merged
   gateway/edge **read filter** is off unless `tenant_settings.feature_flags.mt.community_scope` is on;
   that flag is flipped per tenant only after WS1's resolver is live and the isolation suite is green.
   The **RLS policy rewrite has no feature flag** — it is enforced at the DB the moment the migration
   applies. So the policy-rewrite migration is MIGRATION-QUEUE-sequenced strictly after WS1's
   `is_member()`/`tenant_id_for_policies()` are live AND after this spec's own membership-join backfill
   has populated `tenant_id` on every existing row; and the rewritten read policies keep author-owned
   (`user_id = auth.uid()`) read access for any row whose `tenant_id` is still NULL, so an apply ahead
   of WS2 cannot silently deny community reads. "Merging ahead of activation changes nothing" is true
   for the flag-dark code only, never for the migration.
3. **Expand-only here:** this spec never applies `SET NOT NULL` on the community tables — WS2 backfills
   existing rows first. The RLS rewrite replaces existing (already-enabled) policies rather than
   enabling RLS. Scope by a membership join (`user_tenants`), never by `profiles.tenant_id` (empty
   until WS2).
4. **Community = the active tenant**, not every membership (D8). The Network scope, `network_visible`,
   `send_message*` and Network groups are a different spec — do not add them here. Moderation is
   mt-tenant-admin (O4): for `content_reports` this spec owns `tenant_id` + base RLS at `060*` and
   mt-tenant-admin's `moderator-tenant-scope-db` (`070600`, sorts after) layers the moderation policies
   on top — the two never both own the same policy. Do not add moderation RPCs/triggers/event-games
   here.
5. **Production is read-only** for every session and test (CLAUDE.md 31–32, 48). Kiro never applies a
   migration, deploys, or writes to Supabase/AWS (collaboration §7a); a DB change is a migration file
   in the lane's PR, applied by Kiro via RUN-MIGRATION after merge on the owner's approval (§7d).
6. **D12** one session per VTID, ≤6 concurrent; **D13** no synthetic tenant in production (tests on the
   D11 local stack); the access-token hook (D14) is applied only by the owner. Test/service/platform-
   only accounts never visible to members (rules 43–45). i18n DE-first du-form; RTL via logical
   properties; Spotlight design contract; WCAG 2.2 AA.
7. **Golden:** the Maxina golden suite must stay byte-identical; the isolation suite follows the
   §4.11 Community semantics (Community surfaces return only the active tenant's rows; nothing private
   reachable).
