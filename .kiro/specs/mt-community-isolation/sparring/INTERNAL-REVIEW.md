# Internal review — mt-community-isolation (NN=06)

Independent adversarial review of the WS3 Community-half spec, reviewed fresh against
`BATCH-BRIEF.md` ("Internal review" criteria) and `CROSS-SPEC-DECISIONS.md`. Premises were
re-verified read-only against current code at `file:line`; the `queue.mjs` validators were run
against `handoff.md` and all five lane files. This is a planning-only spec, so there is no build/test
suite to re-run.

## Verdict

APPROVED. No HIGH or MEDIUM findings. Two NITs below (non-blocking). The four cross-spec rulings
naming this spec are all correctly applied; every premise I spot-checked holds in current code; the
validators pass with zero errors.

## queue.mjs validators (decisive, cheap check)

Run via the module's own `parseFrontMatter` + `validatePlan(fm, slug)` / `validateLane(fm, slug,
laneId, laneIds)` with slug/laneId derived from the file/folder names (the signatures the exported
functions actually take):

```
handoff.md                    validatePlan: []   (0 errors)
lanes/community-matches-v1.md  validateLane: []  (0 errors)
lanes/community-scope-gateway.md               : []  (0 errors)
lanes/community-tenant-db.md                   : []  (0 errors)
lanes/founding-pool-tenant-db.md               : []  (0 errors)
lanes/platform-only-accounts-db.md             : []  (0 errors)
```

All six files validate clean. Front matter is well-formed: `handoff.md` has
slug/author/author_seat/executor/next_actor/state/updated; every lane has
lane/state/next_actor/depends_on/executor/seat/reviewer_seat/paths/updated, each `reviewer_seat`
differs from `seat` (hotmail→exafy, jtadic→exafy, exafyltd→jtadic), and in-spec `depends_on`
references (`community-tenant-db`) resolve to real lanes.

## Cross-spec rulings — confirmed applied

- **O5 (platform_only_accounts owned here).** `platform-only-accounts-db` lane / plan Fix / R4 / design
  create the `platform_only_accounts` view (platform-tenant members with no community membership) and
  add it to the rule-45 exclusion lint. requirements/plan state mt-discover only *references* it. ✓
- **C3 (migration version `20261101070160`).** The view migration is pinned to `20261101070160` in the
  lane front-matter path glob (`supabase/migrations/20261101070160_*.sql`), tasks P1, plan Migrations,
  design rule 1, R4, handoff. "do not renumber" is stated in every place. The two `060*` lanes use the
  NN=06 range `20261101060000–065959` / `061*`. No `20261101*` migration exists in the tree yet
  (verified) and MIGRATION-QUEUE.md references no `20261101*` version yet, so the ranges and the pin
  do not collide with anything live. 070160 sorts after mt-tenant-admin's P2/P3 (070100/070150) and
  before `moderator-tenant-scope` (070600), matching the ruling's "P2 → P3 → C3 → moderator-tenant-scope"
  order. ✓
- **O4 (moderation is NOT here).** Plan Out-of-scope, design rule 4, requirements "Not in this spec",
  and the handoff all exclude moderation RPCs/triggers/event-games and assign them to mt-tenant-admin.
  For the one shared table, `content_reports`, this spec owns only `tenant_id` + base RLS at `060*`,
  and defers the moderation policies to mt-tenant-admin's `moderator-tenant-scope-db` (`070600`, which
  sorts after). I grepped the spec body and tasks: no moderation RPC/trigger/event-game is defined
  here. ✓
- **Community scope = ACTIVE tenant.** Plan Fix (`community-scope-gateway`), R2.1, design rule 4,
  handoff, and the lane bodies all state "the member's **active** tenant, not every tenant they belong
  to" (D8). ✓

## Premise verification (read-only, current code)

Verified true:

1. **Community reads scope by visibility only, no tenant filter.**
   - `community-member-ranker.ts` `buildCandidatePool` fetches `repo.fetchVisibleProfileUserIds` +
     `fetchExcludedTestServiceAccountIds`, no tenant predicate (confirmed ~L263-281).
   - `routes/community-members.ts` members directory: same shape, hidden + rule-45 exclusion only, no
     tenant filter (confirmed ~L98-128).
   - `superlatives-repository.ts` `fetchHiddenCommunityProfileUserIds` → `global_community_profiles`
     `is_visible` only.
   - `discovery-tools.ts` exports `tool_global_search` (registered as `global_search`).
   - `social-memory-repository.ts` reads `.eq('tenant_id', tenantId)` at the cited lines (e.g. :259),
     where `tenantId` is a passed-in argument — the "trusts a session-supplied tenant_id" premise is
     accurate.
2. **`generate-daily-matches` candidate pool is cross-tenant** (`is_visible=true` + rule-45 only, no
   `tenant_id`), confirmed `vitana-v1/supabase/functions/generate-daily-matches/index.ts` ~L109-153.
   `daily_matches` table has no tenant column (created in `vitana-v1/.../20251111124306_*.sql`).
3. **Founding pool is global** (the F1 correction is accurate): `20261003100000_vtid_04859_founding_1000.sql`
   defines `founding_members.tenant_id uuid NOT NULL`, `seat_number integer NOT NULL UNIQUE CHECK
   (seat_number BETWEEN 1 AND 1000)`, `claim_founding_seat(p_user_id uuid, p_tenant_id uuid DEFAULT NULL)`
   that resolves the tenant from `user_tenants` and uses a table-wide `COALESCE(max(seat_number),0)+1`
   under a single platform-wide advisory lock (`hashtext('vtid_04859_founding_1000')`). So the gap
   really is per-tenant cap + per-tenant seat numbering + per-tenant lock key, not a column add or
   backfill — exactly what the lane now says. (The plan's line cites `:57,:60,:127` are a few lines off
   from the file-relative positions I read, but every fact is correct — see NIT-1.)
   `billing-repository.ts` `countFoundingSeats` / `FOUNDING_MAX_SEATS = 1000` is global, no tenant
   filter — accurate.
4. **Target tables already have RLS enabled with permissive policies** (the F2 correction is accurate,
   and this is the critical safety claim):
   - `vitana-v1/.../20250917153624_*.sql` enables RLS and creates permissive policies on
     `global_community_profiles` (`is_community_user() AND is_visible`), `global_community_groups`,
     `global_community_events`.
   - `vitana-v1/.../20251010065205_*.sql` enables RLS and creates policies on
     `global_community_group_members` and `content_reports`.
   The four `global_community_*` tables named in premise 4 (`_profiles`, `_groups`, `_events`,
   `_group_members`) are all RLS-on today, so "rewrite existing policies, do not newly enable" is the
   correct framing — the F2 fix is sound. (See NIT-2 on an adjacent legacy table.)

Nothing I checked was wrong or unverifiable.

## Lane sizing / DB-vs-code split / paths

- Five lanes: three DB (`community-tenant-db`, `founding-pool-tenant-db`, `platform-only-accounts-db`)
  and two CODE (`community-scope-gateway`, `community-matches-v1`). DB is split from code per §4.7; the
  founding and platform-only migrations are their own lanes (independent table/RPC/view, own queue
  rows) rather than merged into the community-tables lane, which is defensible under the lane-count
  merge rule (DB lanes stay separate from code lanes; separate tables with separate queue rows).
- `community-scope-gateway` paths enumerate exactly the readers the design lists (ranker + repo,
  superlatives + repo, community-members + repo, users-resolve + repo, billing + repo, discovery-tools,
  social-memory/**, connect-people + repo, test/**). I confirmed every non-glob file exists on disk.
  Narrow and complete for its tasks (G1–G5), including `billing*` for the founding read-reporting (G3)
  whose schema lives in the separate founding DB lane — no path overlap between the two.
- `community-matches-v1` (vitana-v1) paths cover the edge function and both i18n shards it touches.
- `community-tenant-db` / `founding-pool-tenant-db` / `platform-only-accounts-db` paths each cover
  their migration glob + MIGRATION-QUEUE + their pgTAP tests; the plan notes `docs/validation/<vtid>/`
  is intentionally outside the globs per the brief.

## Migration safety

Expand/contract only: nullable `tenant_id` + FK → BEFORE INSERT trigger → batched membership-join
backfill (`bak_*` snapshot first) → `CHECK … NOT VALID` → `VALIDATE`, explicitly stopping before
`SET NOT NULL` (deferred to WS2). `lock_timeout` + retries, pre-approved rollback files, read-only
`live-before.sql`/`post-apply-checks.sql`, one RUN-MIGRATION dispatch per file, applied by Claude.
The founding constraint swap validates per-tenant uniqueness against existing rows before dropping the
global constraint, with a `bak_founding_members` snapshot — correct for the "two tenants can both hold
seat 1" change. Kiro-never-writes-live is stated in every DB lane (collaboration §7a).

The RLS-rewrite-is-not-flag-gated reasoning (design rule 2, plan Risks/Rollout, R1.4) is the strongest
part of the plan: it correctly identifies that the policy rewrite enforces on apply (no feature flag),
must be MIGRATION-QUEUE-sequenced strictly after WS1's `is_member()`/`tenant_id_for_policies()` AND
after this spec's own backfill, and must keep author-owned (`user_id = auth.uid()`) read access for
NULL-`tenant_id` rows so an apply ahead of WS2 degrades safely rather than denying reads.

## Dark-by-default / standing rules

The read path is dark behind `tenant_settings.feature_flags.mt.community_scope` with "flag off =
byte-identical to today" asserted in tests. Staging verification is read-only (rule 48) with a non-GET
network guard. Rule 43–45 exclusion sets are preserved and extended (`platform_only_accounts`). i18n
DE-first du-form for the one new-string path (`community-matches-v1` M3) with `i18n:inventory`.
Maxina golden suite byte-identical. No Google/non-Bedrock AI introduced. No production write anywhere.

## No duplication of DONE work / other specs

Builds on M0 (VTID-05147/05149/05150/05151) and the WS1 resolver without re-planning them; Network
layer, moderation, WS2 `SET NOT NULL`, provisioning, packs, frontend tenant layer, and Discover
`distribution` are all explicitly out of scope and assigned to their own specs. `platform_only_accounts`
is created here once (O5) and only referenced elsewhere.

## Findings

### NIT-1 (LOW) — founding migration line citations are a few lines off
`plan.md` premise 5 / lane body cite `20261003100000_vtid_04859_founding_1000.sql:57,:60,:127`. In the
file I read, `tenant_id uuid NOT NULL` and `seat_number … UNIQUE CHECK (BETWEEN 1 AND 1000)` are around
L44-45 and the table-wide `COALESCE(max(seat_number),0)+1` around L127. Every *fact* is correct; only
the two column line numbers are slightly stale. Non-blocking; fix the two numbers when convenient.
Fix: cite the column block at its actual position (≈L43-45) or drop the exact line numbers for the
column facts and keep them for the `max(seat_number)` line.

### NIT-2 (LOW) — a legacy sibling members table (`global_group_members`) is not addressed
The 2025-09-17 migration created the groups/members system as `global_group_members`; the 2025-10-10
migration added a *second*, newer `global_community_group_members` table (the one this spec correctly
targets). If any live community read still touches the older `global_group_members`, it would remain
un-tenant-scoped after this spec. The spec's named four tables are the right current ones, so this is
not a correctness bug in the plan as written — just a loose end worth a one-line "legacy
`global_group_members` is out of scope / deprecated" note so a successor doesn't assume it was covered.
Fix: add a sentence to design "What exists" or Out-of-scope stating whether `global_group_members` is
dead and intentionally excluded. (Does not block — see also the Open-questions note below.)

## Open questions for sparring (non-blocking)

- The spec's own `## Open questions for sparring` already asks to confirm the WS1 identity spec slug
  that `depends_on`/the external dependency should name once that spec folder exists. Agreed — this is
  a cross-spec coordination item, correctly left as an open question rather than invented. Not a
  blocker.
- Repo-of-record for `daily_matches.tenant_id`: the column is added by the vitana-platform
  `community-tenant-db` lane while the table was created by a vitana-v1 migration, and the vitana-v1
  `community-matches-v1` lane depends on it. This works because both repos share one Supabase project
  and the dependency is declared, but the cross-repo table ownership is worth an explicit line so the
  implementer sequences the shared-DB apply before the vitana-v1 edge-function change. Informational;
  the dependency edge is already in the lane front matter.
