# VTID-04879 — Plan Sparring record

- Change class: standard. Tier: session (plan-sparring skill, partner agent `plan-sparring-partner`, read-only).
- Rounds: 2. Verdict: **CONVERGED** (round 1: 7 findings — F1 blocker, F2–F4 major, F5–F7 minor — all ACCEPTED;
  round 2: all 7 closed, no new findings).
- Final plan hash (canonical, plan-sparring/canonical-hash.ts): `9fbb12a476c5a8f8ccce79650c80d6a2e816069e91b3113618214ba8fd9845bc`
- Owner approval 2026-10-04 (chat): owner decision 3 = option **(b)** — build and merge, but hold the PR that opens the
  member plane on staging until the TypeSafe DPA. Decisions 1 (C2 deferred) and 2 (C3/C19 stay Class A) taken as the
  planner's recommendations; the owner can change either.
- VTID allocated after approval with `p_plan_hash`; the gate was in `log` mode; sparring recorded in
  `vtid_ledger.metadata.sparring`.

## Round 1 findings (verbatim summary)
- F1 [blocker] C19 kind labels wrong for 2 of 4 (`support_question`, `marketplace_claim`). → ACCEPTED
- F2 [major] Marketplace heuristic never returns `none`. → ACCEPTED (dropped)
- F3 [major] `extractAndPersistFacts` returns `Promise<void>`; the C10 write-back needs its count. → ACCEPTED
- F4 [major] Member rules need the env var, the tenant flag listing `member` and a budget. → ACCEPTED (documented)
- F5 [minor] Name the exact C10 insertion point after all six guards. → ACCEPTED
- F6 [minor] Deep-equal assertion on the full `executeReportToSpecialist` result. → ACCEPTED
- F7 [minor] DATABASE_SCHEMA.md for the new subject types. → ACCEPTED

## Round 2
All seven closed; "No new blocker or major findings introduced by the revision." Verdict CONVERGED.

---

# Plan — Jev community Class A decisions, shadow on staging only

Owner instruction 2026-10-04: "build 1–3 next, each as its own PR, in shadow on staging only. start with the Class A
decisions." Context: docs/JEV-INTEGRATION-PLAN.md §8.3 (community use cases) and the approved community cost control
(2026-10-03: "Class A community uses on, no quota"). Slices 1–3 of cost control are live (VTID-04857/04872/04874).

<!-- plan:begin -->
## Change class
standard (new decisions, new gates, a staging workflow pin; no migration, no route, no auth change).

## Goal
Measure, in shadow on staging only, whether Jev can stand in for the existing community decision logic at the
Class A points. Nothing a member sees changes; the existing path always decides. Each Jev verdict is recorded in
`jev_shadow_decisions` next to what the existing path decided, so agreement can be measured before anyone proposes
enforcing (= replacing the existing call).

## Scope — four of the five Class A points; C2 deferred
Research (code map, file:line) found:

| # | Point | Existing logic today | Plan |
|---|---|---|---|
| C1 | Intent routing | `classifyIntentKind` (services/intent-classifier.ts:137): Bedrock Sonnet via `callClaudeText`, 8 kinds + none, confidence < 0.7 → clarify. Awaited by 3 callers: intent-find-match.ts:203, orb-live.ts:6057 (`post_intent`), routes/intents.ts:81 | Shadow gate `community_intent_kind` |
| C2 | Voice tool pre-selection | No LLM selection exists. Deterministic per-session route → tool-group priority (orb/live/tools/session-tool-selection.ts:59-96); Nova's tool list is fixed for the stream | **Deferred.** No LLM to replace (not Class A as written), and per-turn tool changes are impossible on Nova. Re-plan separately if wanted. |
| C3 | Marketplace intent | No LLM. Keyword heuristic `classifyIntent(need)` (services/orb-tools/marketplace-guide-tools.ts:85), behind voice tool `classify_marketplace_intent` | Shadow gate `community_marketplace_intent` beside the heuristic |
| C10 | Worth remembering | Per-turn fact extraction `deduplicatedExtract` → `extractAndPersistFacts` → `memory`-stage LLM (services/extraction-dedup-manager.ts:163-217; inline-fact-extractor.ts:350), member only (`mayWritePersonalFacts`), throttled 60 s / 3 turns | Shadow gate `community_worth_remembering` after the throttle, before the LLM; agreement = whether the LLM then stored ≥1 fact |
| C19 | Member ticket self-triage | No LLM. `report_to_specialist` → SQL RPC `pick_specialist_for_text[_tenant]` (services/report-to-specialist-core.ts:290-317) chooses the kind/persona | Shadow gate `community_ticket_triage` beside the RPC result |

C1 and C10 replace an LLM call if ever enforced (the real Class A saving). C3 and C19 replace a heuristic, not an
LLM, so they save no money; they stay Class A because the owner approved them as Class A (no per-member quota) —
flagged for the owner (see Owner decisions).

## Design
1. **Four decisions** in `services/jev/jev-decisions.ts`, each `data: 'member_content'`, `pii: 'redact'`,
   `planes: INTERNAL_AND_AUTOPILOT`, `community_class: 'A'`, roles engineering-only (system callers always may):
   - `community_intent_kind`: choice over the 8 kinds + `none` (the same labels as intent-classifier.ts:22-30).
     State: the utterance (cut to 1,000 chars).
   - `community_marketplace_intent`: choice over exactly the heuristic's five labels — product / service /
     practitioner / diagnostic_test / combination (marketplace-guide-tools.ts:85-101; the heuristic has no `none`, it
     defaults to `product`). No `none` option, so every verdict is comparable. State: the member's stated need (cut
     to 1,000).
   - `community_worth_remembering`: noul "does this exchange contain a durable personal fact worth remembering in a
     later, unrelated session?". State: the last user turns the extractor would see (cut to 2,000).
   - `community_ticket_triage`: choice `answer_inline` / `file_ticket`, plus a second choice question over the
     ticket kinds the typed tools already use (`bug`, `support_question`, `marketplace_claim`, `account_issue` —
     feedback-settings-tools.ts:312/322/332/342, not invented). Agreement is measured on the first question against the RPC's
     `decision` (report-to-specialist-core.ts:312 `answer_inline` vs a picked persona); the kind is recorded for
     later comparison against the ticket's final kind. The RPC returns persona keys, not kinds, so persona-level
     agreement is out of scope. State: the member's summary (cut to 1,500).
2. **One gate module** `services/jev/gates/community-class-a-gates.ts` with four `run*Shadow` functions, each:
   - fire-and-forget (`void`), never awaited on the member's path, never throws, never changes a return value;
   - returns immediately unless `JEV_<GATE>_MODE` is `shadow` or `enforce` AND `isJevCommunityEnabled()` AND a tenant
     id is present (enforce behaves as shadow in this PR — no enforce path is built);
   - caller `{ actor_id: 'community-class-a', system: true, system_plane: 'system_autopilot', tenant_id }` → spend
     counted as member (VTID-04857), capped by the tenant budget, rate share applies (VTID-04874), no member quota
     (Class A);
   - passes `member_id` (the member's user id) only for telemetry, not quota;
   - records one `jev_shadow_decisions` row: `plane: 'member'`, `tenant_id`, `subject_type` per gate,
     `subject_ref` = a hash of session/turn ids (never the member id or text), `jev_verdict` = the class + probability
     + the existing path's class, `agreed` where both sides gave a class. **No utterance text in the row.**
   - C10's agreement is filled later: the gate returns the shadow row id; `extractAndPersistFacts` changes from
     `Promise<void>` to `Promise<{ persisted: number }>` (inline-fact-extractor.ts:355; the count it already logs at
     :393). Its only direct caller is `deduplicatedExtract` (extraction-dedup-manager.ts:217), which keeps its
     `.catch()` chain and adds a `.then()` writing `persisted > 0` back with `recordJevShadowOutcome`. Callers that
     ignore the value are unaffected (a void-returning use of a value-returning promise type-checks); the
     orb-live.ts/conversation.ts imports are checked and left alone.
3. **Call sites** (one line each, fire-and-forget, after the existing logic has its result):
   - C1: in the three callers right after `classifyIntentKind` returns (they hold user/tenant identity; the classifier
     itself does not). A tiny helper avoids duplicating the call.
   - C3: in the `classify_marketplace_intent` handler after `classifyIntent(need)`.
   - C10: in `deduplicatedExtract` right before the `extractAndPersistFacts` call (~:216), after all six skip guards
     (mayWritePersonalFacts :167, availability :172, length :180, hash :189, time :194, turns :202) have passed;
     outcome write-back after. A turn that is skipped by a guard records nothing (no extraction, nothing to compare).
   - C19: in `executeReportToSpecialist` after the RPC result.
4. **Pins:** `JEV_COMMUNITY_INTENT_KIND_MODE`, `JEV_COMMUNITY_MARKETPLACE_INTENT_MODE`,
   `JEV_COMMUNITY_WORTH_REMEMBERING_MODE`, `JEV_COMMUNITY_TICKET_TRIAGE_MODE` = `shadow` in
   `AWS-STAGE-DEPLOY-GATEWAY.yml` only; `AWS-PROD-DEPLOY-GATEWAY.yml` untouched (a test asserts prod does not set
   them); regenerate flag pins (`scripts/conversation/generate-flag-pins.mjs`).
5. **Inert until PR 2.** `JEV_COMMUNITY_ENABLED` is unset on every gateway, so after this PR the gates return before
   any call even on staging. PR 2 (separate plan) opens the member plane on staging only. Member rules
   (jev-policy.ts:118-122) need all three: `JEV_COMMUNITY_ENABLED=true`, the tenant flag listing `member`, and a
   positive monthly budget. Maxina ($50) and Alkalma ($10) already have the last two since VTID-04857, so PR 2 only
   pins the env var on staging; every other tenant stays denied (`tenant_plane_off`).
6. **Schema doc.** `jev_shadow_decisions.subject_type` is free text; the four new subject types
   (`community_utterance`, `community_marketplace_need`, `community_memory_turn`, `community_ticket`) are added to the
   table's entry in DATABASE_SCHEMA.md. No column changes.

## Tests
- `test/vtid-XXXXX-community-class-a.test.ts`: each decision's schema/questions/labels; each gate skips when mode off,
  community off or no tenant; calls decide with the system_autopilot caller; records the row without text; agreement
  logic; never throws when decide/insert fail; C10 outcome write-back; the existing return values are byte-identical
  (call-site tests); staging pins present, prod absent; `extractAndPersistFacts` returns `{ persisted }` and
  `deduplicatedExtract` still never throws.
- Existing suites green: all Jev suites, operator, roles, support (C19 touches the support pipeline → VTID-04456
  suite must stay green; add a scenario asserting the full `executeReportToSpecialist` return object is deep-equal with the gate on vs off,
  same input — `decision`, `llm_instruction`, `rpc_gate`, the ticket fields).
- Staging verify: read-only (alive, auth-gated jev route) + the suite as `existing` (the gates cannot be reached
  read-only while community is off).

## Data and privacy
- Member text goes to TypeSafe only when PR 2 opens the member plane on staging, only for tenants whose flag lists
  `member` (Maxina, Alkalma), with emails/phones/IBANs redacted. Free text can still contain health content; there is
  no health-text redactor. The TypeSafe DPA/zero-retention is still open (plan §10.6 item 1).
- No member text is stored by us in shadow rows.

## Owner decisions
1. C2 deferred (no LLM to replace) — confirm.
2. C3 and C19 kept Class A (no quota) although they replace heuristics, not LLM calls — confirm, or move to B.
3. Free-text member content reaching TypeSafe before the DPA. This applies to all four gates, not only C10: an
   utterance ("help with my insulin pump"), a marketplace need ("a test for my thyroid") or a ticket summary can carry
   health content as easily as a memory turn; C10 is merely the most frequent and most personal. Options: (a) accept
   for the staging shadow (only Maxina/Alkalma members using the staging host, emails/phones/IBANs redacted, nothing
   stored by us); (b) build and merge everything but keep PR 2 (opening the member plane on staging) until the DPA,
   so no member text leaves before it; (c) exclude C10 only.
<!-- plan:end -->


## Planner responses — round 1
- F1 ACCEPTED — labels corrected to `bug`, `support_question`, `marketplace_claim`, `account_issue` (lines cited).
- F2 ACCEPTED — `none` dropped; the decision mirrors the heuristic's five labels exactly.
- F3 ACCEPTED — `extractAndPersistFacts` returns `{ persisted }`; only direct caller is extraction-dedup-manager.ts:217
  (session-memory-commit.ts calls `deduplicatedExtract`, not `extractAndPersistFacts`, at :212); `.catch()` kept;
  test added. Side channel (OASIS/counter) rejected as harder to join back to the shadow row.
- F4 ACCEPTED — PR 2 precondition documented (all three member rules; Maxina/Alkalma flags already set).
- F5 ACCEPTED — exact insertion point and the six guards named.
- F6 ACCEPTED — deep-equal assertion on the full return object in the VTID-04456 scenario.
- F7 ACCEPTED — DATABASE_SCHEMA.md entry gains the four subject types; no column change.
- Q1 — answered by F2 (no `none`).
- Q2 — answered by F3.
- Q3 — agreed: the DPA exposure covers all four gates; owner decision 3 rewritten with options (a)/(b)/(c).
