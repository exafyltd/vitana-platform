# Internal adversarial review — mt-network (NN=05)

Reviewer: independent internal review (fresh context), 2026-10-15.
Spec: `c:\Users\dstev\vitana-platform-1\.kiro\specs\mt-network\`
Scope judged: `plan.md`, `requirements.md`, `design.md`, `tasks.md`, `handoff.md`, `lanes/*.md`.
Evidence: current code at `file:line` in both checkouts, the brief's "Internal review" criteria, and the CROSS-SPEC rulings naming mt-network. Planning-only; no build/test suite to re-run. queue.mjs validators run below.

## Method
- Read `BATCH-BRIEF.md` and `CROSS-SPEC-DECISIONS.md` in full.
- Ran `parseFrontMatter` + `validatePlan`/`validateLane` from `scripts/collab/queue.mjs` on `handoff.md` and all 11 lane files with the same argument shape the CLI uses (`validatePlan(fm, slug)`, `validateLane(fm, slug, laneId, laneIds)`).
- Verified every numbered premise in `## Problem` against HEAD.

## queue.mjs validators — PASS
Run with the real CLI signatures (slug `mt-network`, lane ids = file names without `.md`, `laneIds` = the set of all lane files):

```
handoff.md validatePlan: []
lane legacy-messages-migration-db.md: []
lane matching-discover-scope-v1.md: []
lane matching-intent-scope-db.md: []
lane messaging-send-db.md: []
lane messaging-send-gateway.md: []
lane messenger-wiring.md: []
lane network-groups-db.md: []
lane network-groups-gateway.md: []
lane network-groups-v1.md: []
lane network-visibility-db.md: []
lane orb-recipient-scope-gateway.md: []
TOTAL FILES WITH ERRORS: 0
```

(An earlier run reported errors only because I passed the arguments in the wrong shape; with the CLI's own call signature every file is clean. No validator error — no HIGH on that axis.)

Front-matter spot checks that back the clean result: every lane carries `executor`, `seat`, `reviewer_seat` (≠ `seat`), `paths`, `depends_on` all within this spec; `next_actor: owner`, `state: ready`; handoff has `author_seat: hotmail`, `state: drafted`, `next_actor: kiro`, `updated`. `depends_on` graph is acyclic and every id resolves to a lane of this spec.

## Premise verification (vs current code)

Verified TRUE:
1. **Inverted messenger switch.** `vitana-v1/src/pages/Messages.tsx` `inboxModes` is `{value:'global', label 'Community'}` / `{value:'tenant', label 'Network'}` — the `tenant` context is the legacy role-gated channel, no `scope` concept. Confirmed. (Line drift: it sits at ~150–153 in HEAD, the plan/design cite `153-154`; content identical — see NIT-1.)
2. **Unguarded service-role `/send`.** `services/gateway/src/routes/chat.ts` builds a `SUPABASE_SERVICE_ROLE` client (`getSupabase()`), `POST /send` (`:57`) inserts `tenant_id: identity.tenant_id, sender_id: identity.user_id` via `repo.insertChatMessage` → `chat-repository.ts:19` `sb.from('chat_messages').insert(row)`. Confirmed.
3. **`connection_requests` self-grantable.** `vitana-v1/supabase/migrations/20251111124306_*.sql`: INSERT policy `WITH CHECK (auth.uid() = from_user_id)` with no `status` constraint and no trigger — a sender can insert a row with `status='accepted'`. (The UPDATE policy already restricts to the recipient, but the INSERT-time self-grant the plan targets is real.) Confirmed.
4. **No `network_visible`.** `global_community_profiles` has `is_visible` only; grep for `network_visible` in migrations: zero. Confirmed.
5. **Matching is cross-tenant + health-fed.** `vitana-v1/supabase/functions/generate-daily-matches/index.ts` pools `global_community_profiles` where `is_visible=true` (no tenant filter) and scores on `vitana_index_scores` (`score_total/sleep/nutrition/exercise/hydration/mental`); `daily_matches` has no scope column. Confirmed.
6. **ORB recipient resolution has no scope.** `orb-tools-shared.ts` calls `resolve_recipient_candidates({ p_global: true })` with a comment that it "can reach anyone with a Vitana account". Confirmed at the cited region.
7. **New RPCs do not exist.** Zero hits across the gateway tree for `send_message`, `send_message_as`, `request_connection`, `respond_connection`. Confirmed.

Supporting infra confirmed present: `services/gateway/src/routes/chat.ts` `/vitana-reply` writer (`:280`, cited `:281`); `docs/multitenancy/MIGRATION-QUEUE.md`; `scripts/ci/migration-drift-baseline.json`; `chat_groups`/`chat_messages` fixtures.

## CROSS-SPEC rulings naming mt-network — all applied
- **Network groups (owned here, M3, flagged).** `plan.md` Fix M3 bullet, `handoff.md` lane list, and `lanes/network-groups-db.md` all state mt-network OWNS Network groups and mt-m3 only references them; the three group lanes are the LAST lanes and flagged `mt.network_groups`. **Matches the ruling exactly.** ✓
- **Migration ordering (C3).** The plan states its own range `20261101050000`–`055959` and that mt-community-isolation's C3 (`070160`) and mt-tenant-admin rows sort AFTER it; it does not claim or collide with the `0701xx` reservations. ✓
- **Lane count merge rule.** DB lanes kept separate from code lanes (§4.7); no cross-repo lane; handoff states the merge rule applied. 11 lanes, each 2–4 PRs — within program budget. ✓
- **Health table list (O1) / lineage guard.** `matching-intent-scope-db` references the mt-guardrails lineage-guard inventory as a stated dependency and does not duplicate the list; `isHealthTable()` referenced as owned by mt-identity. ✓
- **O2/O3/O4/O5** are not mt-network's to own; the plan does not re-plan any of them and keeps the Vitana-Index removal (D25) local. No stale `moderation-tenant-db` reference. ✓

## Lane sizing, paths, DB/code split, dark-by-default — sound
- DB work (scope columns, RPCs, revokes, triggers, legacy migration, matching DB) is split from code work by repo and by §4.7; `messaging-send-db`/`network-visibility-db`/`legacy-messages-migration-db`/`matching-intent-scope-db`/`network-groups-db` are DB-only; the gateway/v1 lanes are code-only. ✓
- `paths` are narrow globs and cover the files each lane's tasks touch, including tests; `docs/validation` omitted and noted per the brief. The messenger lanes explicitly list `src/pages/Messages.tsx` (the live file) alongside the `src/components/messages/**` area key. Shared-file hazards (`orb-tools-shared.ts` between `messaging-send-gateway` and `orb-recipient-scope-gateway`; `chat-groups-repository.ts` between `messaging-send-gateway` and `network-groups-gateway`; `Messages.tsx`+`inbox.json` between `messenger-wiring` and `network-groups-v1`) are each called out with a merge-sequencing note. ✓
- Dark by default behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.network_enabled`/`mt.network_groups`; the only non-dark element is the one-time network-visibility prompt, declared as a recorded Maxina golden exception (D23). ✓
- Migration safety: expand/contract for every `scope` column (`DEFAULT 'community'` → backfill → drop default), pre-approved rollback under `docs/validation/<vtid>/`, read-only pre/post checks, `bak_*` snapshot (30 days) for the data move, MIGRATION-QUEUE row in the same PR, drift-baseline entries for not-yet-live objects. ✓
- Standing rules present: never test against production (31/31b/48), staging read-only, rules 43–45 (rule-45 trigger + both scopes exclude test/service/platform-only), 42c (`npm run test:support`), i18n DE-first du-form + RTL, Spotlight, no What's New entry claimed, Bedrock-only (no LLM-routing change here). ✓
- Executor-never-writes posture (§7a) stated in every DB lane; migrations applied by Claude via RUN-MIGRATION. ✓

## No duplication of DONE work / other specs
Builds on M0 (05147/05149/05150/05151) by reference; defers community feed/directory scoping, events/live-rooms, the auth-token hook (mt-identity), health-table re-keying (mt-native-health), and Discover catalog gating (mt-discover) to their owning specs under `## Out of scope`. No overlap found.

## Findings

See INTERNAL-REVIEW.json. No HIGH or MEDIUM findings. Two NITs below (non-blocking).

- **NIT-1 — `inboxModes` line reference drifted.** `plan.md` Problem §1 and `design.md` cite `Messages.tsx:153-154`; the block is at ~150–153 in HEAD. Content is identical and unambiguous, and the plan itself warns refs may have drifted. Fix: update the citation to the current line, or drop the line number and keep the symbol name.
- **NIT-2 — cross-repo migration-dir note.** All DB lanes place migrations in `vitana-platform/supabase/migrations/`, but `global_community_profiles`, `connection_requests`, `daily_matches` and the legacy message/thread tables were historically created in `vitana-v1/supabase/migrations/` (one shared Supabase project; `chat_messages` is already platform-side). The brief's routing rule ("supabase/migrations + DB lanes → hotmail", spec home = platform) covers this, and the drift-baseline/queue tooling the lanes use is platform-side, so it is consistent — but worth one line in the plan noting that ALTERs to v1-origin tables are intentionally driven from the platform migration tree, so a later reader (or v1's own drift check) does not read it as a mistake. Non-blocking.

## Verdict
Zero HIGH and zero MEDIUM findings → **APPROVED**. The two open questions under `## Open questions for sparring` (messaging-preference storage; first-contact rate-limit store) are explicitly non-blocking and correctly parked for CI sparring.
