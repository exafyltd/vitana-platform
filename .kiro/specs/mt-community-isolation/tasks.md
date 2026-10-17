# Tasks — Community isolation (WS3 Community part)

Authoritative plan: `plan.md`. Lane files: `lanes/`. VTIDs allocated by PLAN-SPAR after approval.
Each lane adds its own `docs/validation/<VTID>/` (plan copy, `scope.json`, `staging-tests.json`),
which is intentionally not in the Allowed paths globs below (per the brief).

<!-- lane: community-tenant-db -->
## community-tenant-db — community tables tenant_id + RLS (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101060*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`,
`supabase/tests/mt_community_isolation_*.sql`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] T1 Add `tenant_id uuid` (nullable) + FK to `tenants` on `profile_posts`, the four
      `global_community_*` tables (`global_community_profiles`, `global_community_groups`,
      `global_community_events`, `global_community_group_members`), `media_uploads`,
      `community_live_streams`, `calendar_events`, `content_reports`, `feedback_tickets`,
      `daily_matches`; BEFORE INSERT trigger filling it from the actor's resolved tenant. Version
      `20261101060000`.
- [ ] T2 Batched membership-join backfill of existing rows (1–5k/txn, off-peak), `bak_*` snapshot
      first; then `CHECK (tenant_id IS NOT NULL) NOT VALID` → `VALIDATE`. **No `SET NOT NULL`** (WS2).
- [ ] T3 These tables already have RLS enabled with permissive policies — **rewrite** (do not newly
      enable) every policy: user-private (`user_id = auth.uid() AND tenant_id =
      tenant_id_for_policies()`), tenant-shared (`is_member(tenant_id)`), admin-only
      (`is_tenant_admin(tenant_id)`); confirm `ROW LEVEL SECURITY` is enabled on each; add the realtime
      tenant predicate for realtime-reachable tables. Rewritten SELECT policies keep author-owned
      (`user_id = auth.uid()`) read access for NULL-`tenant_id` rows. For `content_reports` rewrite
      `tenant_id` + base RLS only — mt-tenant-admin's `moderator-tenant-scope-db` (`070600`) layers
      moderation policies on top (O4). **The policy rewrite is NOT flag-gated**; its MIGRATION-QUEUE
      row (T4) is placed strictly after the WS1 resolver/membership rows AND after the T2 backfill.
- [ ] T4 Rollback migration + `live-before.sql` / `post-apply-checks.sql` under
      `docs/validation/<VTID>/`; add MIGRATION-QUEUE rows after the WS1 resolver/membership rows.
- [ ] T5 pgTAP `supabase/tests/mt_community_isolation_*.sql`: `b_member` reads 0 `T_A` rows per table;
      a foreign-tenant write fails; RLS enabled; realtime predicate present.

Acceptance: migrations expand-only, `lock_timeout`+retries, snapshot before data move, rollback +
pre/post checks present, MIGRATION-QUEUE updated, pgTAP green. No `SET NOT NULL`. Kiro never applies a
migration against any live system.

<!-- lane: founding-pool-tenant-db -->
## founding-pool-tenant-db — Founding pool per tenant (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101061*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`,
`supabase/tests/mt_founding_pool_*.sql`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] F1 **No column add, no `tenant_id` backfill** — `founding_members.tenant_id` and
      `claim_founding_seat(p_user_id, p_tenant_id)` already exist and are populated (VTID-04859,
      `20261003100000_vtid_04859_founding_1000.sql:60,99-112`). Migration `20261101061000`:
      `bak_founding_members` snapshot first, verify `tenant_id` is already populated (fail loudly if
      any row is NULL), then replace the global `seat_number ... UNIQUE` + `CHECK (seat_number BETWEEN
      1 AND 1000)` (`:57,:127`) with `UNIQUE (tenant_id, seat_number)` and a per-tenant cap check,
      validated against existing rows before dropping the global constraints.
- [ ] F2 Rewrite `claim_founding_seat` so the seat sequence is per tenant (replace the table-wide
      `COALESCE(max(seat_number),0)+1` at `:127` with a `WHERE tenant_id = v_tenant_id` max) and
      `v_max_seats` is the per-tenant cap. The existing tenant resolution (`p_tenant_id` →
      `user_tenants`) and the advisory lock stay; make the lock key per tenant so two tenants do not
      serialise against each other.
- [ ] F3 Rollback migration + read-only pre/post checks under `docs/validation/<VTID>/`; MIGRATION-QUEUE
      row after the community-tables rows.
- [ ] F4 pgTAP `supabase/tests/mt_founding_pool_*.sql`: two tenants each seat independently up to the
      cap; a seat is counted only in its own tenant; two tenants can both hold seat 1.

Acceptance: no column add / no `tenant_id` backfill (verified populated instead), snapshot + rollback +
pre/post checks, per-tenant cap and per-tenant seat numbering proven by pgTAP. Gateway reporting lives
in `community-scope-gateway`. Kiro never applies a migration live.

<!-- lane: platform-only-accounts-db -->
## platform-only-accounts-db — platform_only_accounts view, M2 / O5 (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101070160_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`,
`supabase/tests/mt_platform_only_accounts_*.sql`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] P1 Create `platform_only_accounts` view (platform-tenant members with no community membership)
      in migration **`20261101070160`** (pinned, cross-spec C3 — do not renumber).
- [ ] P2 Add the view to the rule-45 exclusion lint beside `service_bot_accounts` /
      `notification_test_actors`.
- [ ] P3 MIGRATION-QUEUE row as the C3 position (after the two `20261101060*` lanes) + drift-baseline
      entry (removed after apply); rollback + read-only pre/post checks under `docs/validation/<VTID>/`.
- [ ] P4 pgTAP `supabase/tests/mt_platform_only_accounts_*.sql`: a platform-only account appears in the
      view and never in any community-member surface.

Acceptance: view created at version `20261101070160`, rule-45 lint extended, pgTAP green, QUEUE +
baseline updated. Kiro never applies a migration live.

<!-- lane: community-scope-gateway -->
## community-scope-gateway — Community read surfaces scoped to active tenant (repo vitana-platform)

Allowed paths: `services/gateway/src/services/voice-tools/community-member-ranker.ts`,
`services/gateway/src/services/voice-tools/community-member-ranker-repository.ts`,
`services/gateway/src/services/voice-tools/superlatives.ts`,
`services/gateway/src/services/voice-tools/superlatives-repository.ts`,
`services/gateway/src/routes/community-members.ts`,
`services/gateway/src/routes/community-members-repository.ts`,
`services/gateway/src/routes/users-resolve.ts`,
`services/gateway/src/routes/users-resolve-repository.ts`,
`services/gateway/src/routes/billing.ts`, `services/gateway/src/routes/billing-repository.ts`,
`services/gateway/src/services/orb-tools/discovery-tools.ts`,
`services/gateway/src/services/social-memory/**`,
`services/gateway/src/services/automation-handlers/connect-people.ts`,
`services/gateway/src/services/automation-handlers/connect-people-repository.ts`,
`services/gateway/test/**`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] G1 Behind `feature_flags.mt.community_scope`, add the active-tenant membership-join filter to the
      `community-member-ranker` pool, members directory, superlatives, `tool_global_search`,
      `resolve_recipient_candidates` (community branch), and `connect-people`. Flag off = unchanged.
- [ ] G2 Social-memory resolver takes the active tenant from `TenantContext`, never a tool/call
      argument (`social-memory-service.ts`, `social-context-builder.ts`, `person-context-builder.ts`,
      `social-memory-repository.ts`).
- [ ] G3 `countFoundingSeats` / `/founding-status` report per the viewer's tenant (read-only).
- [ ] G4 A lint/test banning a community read scoped only by visibility (no tenant predicate).
- [ ] G5 Jest in `services/gateway/test/**`: each reader returns only the active tenant's members with
      the flag on, byte-identical with it off; resolver ignores a supplied tenant.

Acceptance: dark by default, Network scope untouched, lint green, full gateway test suite green,
Maxina golden suite byte-identical. Kiro never writes to a live system.

<!-- lane: community-matches-v1 -->
## community-matches-v1 — daily matches candidate pool scoped (repo vitana-v1)

Allowed paths: `supabase/functions/generate-daily-matches/**`, `src/i18n/de/matches.json`,
`src/i18n/en/matches.json`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] M1 Behind `feature_flags.mt.community_scope`, scope the `generate-daily-matches` candidate pool
      to the viewer's active tenant; keep the rule-45 exclusion. Flag off = unchanged.
- [ ] M2 Write the `daily_matches` tenant column (from `community-tenant-db`) on insert.
- [ ] M3 Any new user-visible string DE-first du-form in `src/i18n/de/matches.json`, mirrored to
      `src/i18n/en/matches.json`; `match_reasons` stays `{key, params}`; `npm run i18n:inventory`.
- [ ] M4 Vitest: pool scoped with the flag on, unchanged off; tenant written on insert.

Acceptance: dark by default, Network untouched, Vitest + full `npx vitest run` green, ESLint i18n
clean. Kiro never runs the edge function against production.
