# Plan — Vitanaland Loop Engineering: Top 100 Loops catalog + Command Hub "Loops" screen

<!-- plan:begin -->
## 0. Meta
- **Change class:** standard (new gateway route, Command Hub module, nav change; no migration, no auth change, no LLM-routing change, no workflow YAML change; one CI script — the ownership-guard allowlist — is touched).
- **Repos:** `exafyltd/vitana-platform` only. `exafyltd/vitana-v1` is untouched by this plan.
- **Owner request (2026-10-12):** make Vitanaland a self-improving system based on loop engineering; build a screen in Command Hub → Autonomy listing the Top 100 loops.
- **This plan delivers Phase 1 only** (catalog + screen + doctrine doc). Phases 2–5 in §6 are a roadmap; each gets its own plan, its own sparring and its own VTID. Approving this plan does not approve them.

## 1. Definition used (the "loop contract")
A Vitanaland loop is a repeating cycle **Trigger → Goal → Act → Observe → Adjust → Verify/Stop**, with eight mandatory properties. A catalog entry is invalid (test fails) unless all are filled:

| Field | Meaning |
|---|---|
| `trigger` | cron / event / threshold that starts a run |
| `goal` | an externally checkable finish line (a number or a pass/fail check, never "make X better") |
| `act` | the tools the loop may call |
| `verifier` | an independent check — never the generating agent grading itself |
| `stop` | done condition + stagnation rule (same error N times or no measurable progress → stop and escalate) |
| `human_gate` | which actions need a human (`none` allowed only for risk R0/R1) |
| `budget` | max iterations / spend / wall time per run |
| `metrics` | what is measured to prove the loop improves the system |

Classification fields: `domain`, `risk` (R0 internal read-only · R1 internal reversible · R2 member-visible or money · R3 health, payments, legal, personal data), `autonomy` (L0 observe · L1 recommend · L2 prepare-for-approval · L3 execute-bounded), `status` (LIVE = runs today · PARTIAL = runs today but lacks a contract field, usually the verifier, feedback or auto-remediation · PLANNED), `existing_ref` = `{ repo: 'vitana-platform' | 'vitana-v1', kind: 'file' | 'glob' | 'workflow' | 'routine' | 'table', ref }` (required for LIVE/PARTIAL), `gap` (what PARTIAL lacks), `wave` (1/2/3 build order).

Hard invariants enforced by the catalog test: R2/R3 ⇒ `human_gate` ≠ none; R3 ⇒ autonomy ≤ L2; any loop touching health output ⇒ "no diagnosis / no treatment claim" verifier; no loop may route an LLM stage to Google (CLAUDE.md 10a–10c, IF-THEN 27); no loop writes community content as a test account (rules 31/43).

## 2. The Top 100 loops (10 domains × 10)
Status counts come from the read-only inventory of the current code (2026-10-12). Columns: ID · Loop · Trigger · Verifiable goal / stop · Gate · Status (existing_ref) · Wave.

### P — Platform reliability & self-healing
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| P01 | Self-healing diagnose → spec → fix → verify | failure report | probe green after deploy; cap → escalate | spec approval | LIVE `self-healing-*-service.ts` | – |
| P02 | Orphaned-heal reconciler | every 10 min | no `pending` heal older than 30 min | escalate at cap | LIVE `self-healing-reconciler.ts` | – |
| P03 | Voice recurrence sentinel + quarantine + rollback | after a voice fix | failure class absent 7 days | rollback by human | PARTIAL `voice-recurrence-sentinel.ts` (rollback is telemetry only) | 2 |
| P04 | Staging verify → fix-forward | staging deploy | STAGING-VERIFY green on deployed commit | Gate 2 | LIVE `STAGING-VERIFY.yml` | – |
| P05 | Push-dispatch health → remediation | every 20 min | delivery rate ≥ threshold | escalate | PARTIAL `ALERT-PUSH-DISPATCH-HEALTH` (alert only) | 2 |
| P06 | Screen-load latency regression → fix VTID | every 30 min | p75 load under budget per screen | VTID review | PARTIAL `SCREEN-LOAD-TIMING` (no auto-VTID) | 2 |
| P07 | ORB bootstrap latency | hourly | p95 under budget | escalate | PARTIAL `ALERT-ORB-BOOTSTRAP-LATENCY` | 2 |
| P08 | Migration drift → reconcile PR | daily | zero drift repo↔DB | human applies | PARTIAL `MIGRATION-DRIFT-CHECK` | 3 |
| P09 | Identity drift repair | daily | zero orphan `app_users` identities | human | PARTIAL `APP-USERS-IDENTITY-DRIFT` | 3 |
| P10 | Connector token health | timer | 0 expired tokens on active connectors | member re-consent | PARTIAL OAuth token refresher | 3 |

### E — Engineering & delivery
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| E01 | Dev Autopilot scan → plan → PR → merge → verify | cron 07/19 + 30 s executor | finding closed with verified deploy; retry breaker | approval gates | LIVE `dev-autopilot-execute.ts` | – |
| E02 | LLM merge review | per run | review pass before merge | gate | LIVE `dev-autopilot-llm-review.ts` | – |
| E03 | Retry breaker / outage gate | per failure | ≤5 failures/24 h per finding then stop | escalate | LIVE `dev-autopilot-retry-breaker.ts` | – |
| E04 | Outcome-driven graduation | weekly | finding classes with proven record auto-approve; others not | owner approves each graduation | PARTIAL `dev-autopilot-outcomes.ts` (records, nothing acts) | 2 |
| E05 | Prompt learnings from failed runs | per failure | repeat-failure rate down per class | review | PARTIAL `dev_autopilot_prompt_learnings` | 2 |
| E06 | Repair-pattern reuse | per repair | known fix reused, success rate tracked | review | LIVE `repair-pattern-store.ts` | – |
| E07 | Plan-sparring quality loop | per sparring | accepted-finding rate and post-merge defect rate tracked | owner | PLANNED | 3 |
| E08 | Draft-PR babysitter | routine cron | no draft PR stale > N days without action | author | LIVE `routines/draft-pr-babysitter` | – |
| E09 | Health-hotspot reduction | weekly | worst-file health score up; finding → autopilot | approval gates | PLANNED (repowise health → findings) | 3 |
| E10 | Dependency & security patch loop | advisory | CVE patched with green CI | approval gates | PLANNED | 2 |

### Q — Quality & testing
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| Q01 | Test-contract failure → repair VTID | scheduled | contract green; debounce/quarantine | review | LIVE `test-contract-failure-scanner.ts` | – |
| Q02 | Missing-test scanner | scheduled | changed route has a test | review | LIVE `missing-test-scanner.ts` | – |
| Q03 | Flaky-test detector → robustness fix | CI history | same-commit pass/fail rate → 0 for fixed tests (never skip/disable) | review | PLANNED | 2 |
| Q04 | Nightly full staging suite | 02:17 | full run green < 24 h old | Gate 2 | LIVE `STAGING-VERIFY-NIGHTLY` | – |
| Q05 | Support regression suite growth | ticket closed | every closed bug adds a scenario | review | PLANNED (`vtid-04456` suite) | 3 |
| Q06 | Accessibility scan of changed screens | PR | WCAG 2.2 AA zero new violations | blocks merge | PLANNED | 2 |
| Q07 | Visual regression on changed screens (staging, read-only) | staging deploy | screenshot diff within tolerance | review | PLANNED | 3 |
| Q08 | Nav registry ↔ App.tsx drift | every PR | registry complete | blocks merge | LIVE `src/navigation/registry` test (v1) | – |
| Q09 | CSP violation report → fix | report | zero violations per release | review | PLANNED | 3 |
| Q10 | Error-log clustering → self-healing intake | scheduled | each new cluster has a heal or VTID | review | PARTIAL `jev/gates` root-cause roll-up | 2 |

### V — Voice / ORB quality
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| V01 | Opener-outcome gate | scheduled | greeting success rate ≥ target | shadow→enforce by owner | LIVE `jev/gates` | – |
| V02 | Slow-session cluster → fix | scheduled | slow-session share under target | review | LIVE `jev/gates` | – |
| V03 | Backstop/tool-fallback cluster | scheduled | fallback rate down | review | LIVE `jev/gates` | – |
| V04 | Persona voice gender guard | every build | zero wrong-gender voices | blocks build | LIVE `vtid-04445` test | – |
| V05 | ORB tool success rate → schema/description tuning | daily | per-tool success ≥ target | PR review | PLANNED | 2 |
| V06 | Voice-navigation misroute → registry phrasing PR | daily | misroute rate down | PR review | PLANNED | 2 |
| V07 | STT language-detection accuracy | daily | wrong-locale sessions under target | review | PLANNED | 3 |
| V08 | Greeting anti-repeat cadence | per session | no identical greeting twice in N sessions (model-composed, rule 41) | review | PARTIAL greeting brain | 3 |
| V09 | Voice provider quality/cost per language + ru/sr carve-out review | weekly; reminder 2026-12-06 | quality and cost per language reported; window decision ready | owner | PLANNED | 2 |
| V10 | Shadow-eval model promotion | hourly / daily | promotion proposed only with eval evidence | human promotes | LIVE `CRON-AUTO-PROMOTER`, `CRON-GRADUATION-RECOMMENDER` | – |

### H — Vitana preventive-health assistant (all R3: no diagnosis, no prescription, no autonomous purchase)
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| H01 | Daily check-in → plan adjust | member check-in | plan updated and accepted/rejected recorded | member confirms | PLANNED | 3 |
| H02 | Wearable/sleep signal → non-diagnostic insight | consented data | insight delivered within claim policy | claim verifier | PLANNED | 3 |
| H03 | Lab upload → explain + refer to professional | upload | explanation passes claim verifier; referral offered | professional | PLANNED | 3 |
| H04 | Red-flag symptom escalation (deterministic rules first) | any member text/voice | red-flag → urgent-care guidance 100% on eval set | none may suppress | PLANNED | 2 |
| H05 | Adherence → reminder cadence | reminders | adherence up without mute/unsubscribe rise | member | PARTIAL reminders dispatch | 3 |
| H06 | Recommendation outcome feedback | accept/reject | acceptance rate up per category | review | PARTIAL `recommendation-engine` | 2 |
| H07 | Guided-journey checklist regenerate | supervisor | checklist matches member stage | supervisor | LIVE `checklist-regenerate.ts` | – |
| H08 | Longevity index daily recompute | daily | recompute run succeeds for all active members | – | LIVE `daily-recompute-service.ts` | – |
| H09 | Suggest product/service → prepared cart (never executed) | plan | cart prepared; purchase only on member click | member | PLANNED | 3 |
| H10 | Health-claims verifier on assistant replies | every health reply | zero diagnosis/treatment claims on eval set | blocks reply | PLANNED | 2 |

### S — Supplier onboarding & catalog
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| S01 | Supplier onboarding (status → next_action) | signup / MCP | all onboarding steps valid; supplier confirms | human review | PARTIAL `partner-verification.ts` | 1 |
| S02 | Feed normalization (CSV/Shopify/Woo → schema), deterministic validators before any LLM | feed import | 80% of rows normalized and valid without manual entry | human publish | PARTIAL Shopify/Awin sync workers | 1 |
| S03 | Prohibited health-claim scanner on product copy | product create/update | zero prohibited claims published | human review | PLANNED | 1 |
| S04 | Certificate/document expiry watcher | daily | no live listing with expired certificate | supplier + admin | PLANNED | 2 |
| S05 | Duplicate SKU detection | import | zero duplicates published | admin | PLANNED | 2 |
| S06 | Broken image / media check | import + weekly | zero broken images on live listings | admin | PLANNED | 1 |
| S07 | Marketplace sync drift | 03:00 | catalog matches source | – | LIVE `MARKETPLACE-SYNC-CRON` | – |
| S08 | Supplier performance score | weekly | score published to supplier dashboard | admin | PLANNED | 3 |
| S09 | Price / availability change watcher | feed delta | listing reflects source within SLA | admin above threshold | PLANNED | 2 |
| S10 | Inventory days-of-cover → reorder draft | stock threshold | draft PO ready; never auto-paid | human PO | PLANNED | 3 |

### C — Listing quality & creator commerce
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| C01 | Listing completeness audit → improvement draft | new/updated listing | listing passes schema + media + completeness | supplier approves | PLANNED | 1 |
| C02 | Copy rewrite under no-medical-claim verifier, measured CTR/CVR | low conversion | conversion up vs control; claim verifier pass | supplier approves | PLANNED | 2 |
| C03 | Image quality / background consistency | upload | image check pass | supplier | PLANNED | 2 |
| C04 | SEO fields + category correctness | listing | fields complete, category validated | auto L3 only for R1 fields | PLANNED | 2 |
| C05 | Video → primary product match (product drawer) | creator upload | one approved product anchored | creator approves | PLANNED | 3 |
| C06 | Caption / hashtag / thumbnail variants | creator upload | variants pass claim verifier | creator approves | PLANNED | 3 |
| C07 | Post-publish performance → next content angle | 7 days after publish | recommendation delivered with metrics | creator | PLANNED | 3 |
| C08 | Review quality / fraud monitor | new review | suspicious reviews held | moderator | PLANNED | 2 |
| C09 | Affiliate link health + commission reconciliation | daily | zero dead affiliate links; commissions reconcile | finance | PARTIAL Awin sync | 2 |
| C10 | Zero-result search → catalog gap / synonym | daily | zero-result rate down | admin | PLANNED | 3 |

### M — Community & engagement
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| M01 | Community autopilot scan → propose → supervise | scheduler | proposals approved/rejected tracked | supervisor | LIVE (shadow) `community-autopilot/*` | – |
| M02 | Admin awareness scanners → insights | every 5 min | KPI insights per tenant | tenant admin | LIVE `admin-awareness-worker.ts` | – |
| M03 | Morning-brief pacing | hourly | open rate up without mute rise | – | PARTIAL morning-brief scheduler | 2 |
| M04 | Onboarding drop-off nudges | lifecycle event | activation rate up | – | PARTIAL lifecycle-notification worker | 2 |
| M05 | Intent-match feedback | recompute | match acceptance rate up | member | PARTIAL intent match recompute (v1 pg_cron) | 3 |
| M06 | Welcome flow health | daily | greeting delivered to every new member | escalate | LIVE `ALERT-WELCOME-GREETING` | – |
| M07 | Test/service-account leak scan (rules 43–45) | daily | zero test accounts on member-facing surfaces | escalate P1 | PLANNED | 1 |
| M08 | Notification fatigue → throttle | daily | mute/unsubscribe rate under target | – | PLANNED | 2 |
| M09 | Event attendance feedback → recommendations | after event | attendance rate up | – | PLANNED | 3 |
| M10 | Moderation report triage | report | report classified < SLA, human decides | moderator | PLANNED | 2 |

### K — Content, i18n & knowledge
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| K01 | What's New drafter | merge to main | draft PR for new finished features only | human merges | LIVE `WHATS-NEW-DRAFT.yml` (v1) | – |
| K02 | What's New publisher | live build | card + push once per entry | – | LIVE `whats-new-publisher.ts` | – |
| K03 | i18n propagate DE → all locales | PR | all 11 locales complete | blocks merge | LIVE `I18N-PROPAGATE` (v1) | – |
| K04 | i18n LLM audit → apply ≥ 0.80 suggestions | scheduled (today manual) | audit score per locale up | review | PARTIAL `i18n-audit-llm.yml` (manual only) | 2 |
| K05 | du-form register guard | PR | zero Sie/Ihr/Ihnen in DE | blocks merge | PLANNED | 2 |
| K06 | RTL check on new screens (ar) | PR | no physical left/right on new screens | review | PLANNED | 3 |
| K07 | Knowledge docs freshness | routine | no doc older than N days vs code | review | LIVE `routines/knowledge-docs-freshness` | – |
| K08 | Longevity news → claim-checked curation | fetch | items pass claim verifier | editor | PARTIAL longevity news fetcher | 3 |
| K09 | Support answer acceptance → knowledge base | answer sent | acceptance rate up; KB gap filed | supervisor | PARTIAL `feedback-answer-drafter.ts` | 2 |
| K10 | Rules/CLAUDE.md ↔ code drift | weekly | every rule's referenced path exists | review | PLANNED | 3 |

### G — Governance, safety, cost & data
| ID | Loop | Trigger | Goal / stop | Gate | Status | W |
|---|---|---|---|---|---|---|
| G01 | Support ticket → Devon spec → autopilot → reporter notified | ticket | ticket closed and reporter notified | dispatch activation | LIVE `feedback-*` pipeline | – |
| G02 | OASIS ledger integrity | daily | zero integrity violations | escalate | LIVE `ALERT-OASIS-LEDGER-INTEGRITY` | – |
| G03 | Plan-sparring gate reconciler | hourly | tamper → P1 | owner | LIVE (env flag) `plan-sparring/reconciler.ts` | – |
| G04 | LLM spend per stage → budget alert/throttle | hourly | spend per stage within budget | owner | PLANNED | 1 |
| G05 | Silent model-fallback detector (any Google fallback = incident) | per AI call log | zero unlogged fallbacks | escalate | PLANNED | 1 |
| G06 | GCP carve-out window watcher (ru/sr bridge, audiobook cap) | daily; 2026-12-06 | spend under cap; decision prompt before window end | owner | PLANNED | 2 |
| G07 | Nightly memory consolidation | nightly | consolidator run succeeds | – | PARTIAL `nightly-consolidator.ts` (schedule unconfirmed) | 2 |
| G08 | Memory embedding backfill | timer | zero un-embedded memory items | – | LIVE `memory-embedding-backfill-loop.ts` | – |
| G09 | Consent & health-data access audit | daily | every health-data read has consent + purpose | DPO | PLANNED | 2 |
| G10 | Secret hygiene → rotation VTID | daily | zero hard-coded secrets in repo | owner | PLANNED | 1 |

**Totals (to be recomputed by the catalog test):** LIVE 31 · PARTIAL 23 · PLANNED 46 = 100.
**Wave 1 (next build after this plan):** S01, S02, S03, S06, C01, M07, G04, G05, G10.

## 3. What Phase 1 builds
1. **Catalog spec** `services/gateway/specs/loop-catalog-v1.json` — the 100 entries above, every contract field from §1 filled, `version`, `generated_at`. Source of truth in the repo (reviewable in PRs). No DB table in Phase 1.
2. **Service** `services/gateway/src/services/loop-catalog.ts` — loads and validates the spec at startup (fail loudly on an invalid catalog, ALWAYS rule 10), and attaches a **read-only live signal** for entries that declare a `run_plane`, whose allowed values are exactly the view's `plane` column: `dev_autopilot`, `community_autopilot`, `self_healing` (and any native `agent_runs.plane`); the query is `plane = <run_plane>` over the last 7 days, giving counts by `status` and the latest `created_at`, from the existing `agent_runs_unified` view (latest definition `supabase/migrations/20260923210000_vtid_04446_run_leases.sql`). One query per distinct plane (≤ 4), cached 60 s. Signal is labelled plane-level, not per-loop. A view error degrades the signal to `unavailable`, never fails the catalog.
3. **Route** `services/gateway/src/routes/autonomy-loops.ts` — `GET /api/v1/autonomy/loops` (catalog + signals + totals) guarded by the exported shared middleware `requireAuth` + `requireExafyAdmin` from `middleware/auth-supabase-jwt.ts:384,462` (same effect as the local `requireDevRole` copies in `autonomy-pulse.ts`; no new copy, and `autonomy-pulse.ts` is not edited). It is a separate router with one path `GET /loops`, mounted at `/api/v1/autonomy` next to the pulse and trace routers (`index.ts:895-896` already mounts two routers on that prefix; paths do not overlap). GET only. One unpaginated payload: 100 entries, roughly 100 KB, which is small enough.
4. **Command Hub screen** Autonomy → **"Loops"** (`/command-hub/autonomy/loops/`):
   - new module `loops-catalog.js` + `loops-catalog.css`. The JS goes in `modules.json` → `bundle` as `kind: "module"`, placed before `app.js` like `kiro-console.js`, and exposes `window.LoopsCatalog.render(container)`. Both files get `<script>`/`<link>` tags with `?v=YYYYMMDD-vtid-<VTID>` in `index.html`, and `app.js`/`styles.css` get a `?v=` bump only if they change;
   - `app.js`: one `NAVIGATION_CONFIG` tab entry (`loops`, 7th Autonomy tab; the Command Hub is desktop-first and the existing tab bar already wraps) and one render-switch hook. The hook guards `window.LoopsCatalog` the same way `app.js:1501-1503` guards `PipelineTree`/`KiroConsole`, and shows an inline error state if the module is missing;
   - UI: header KPIs (LIVE/PARTIAL/PLANNED, by risk, wave-1 count); filters (domain, status, risk, autonomy, wave) and search; table of 100 loops; a detail panel per loop showing the Trigger → Goal → Act → Observe → Adjust → Verify/Stop cycle, gate, budget, metrics, gap, existing ref and live signal; a short "What is loop engineering" panel. Event handlers via `addEventListener` (CSP `script-src 'self'`), keyboard-reachable rows and ARIA labels (t10 tests). Read-only: no buttons that act.
5. **Regenerated catalogs:** `navigation-config.js` and `specs/dev-screen-inventory-v1.json` are regenerated by `regen-screens-catalog.mjs` from the runtime `NAVIGATION_CONFIG`; they are never edited by hand. The PR includes the regenerated output, which shows the `loops` tab, and `--check` must pass.
6. **Doctrine doc** `docs/autonomy/LOOP-ENGINEERING.md` — the loop contract, risk/autonomy ladders, the rules (separate doer and checker, external finish line, state outside the model, budgets, stagnation stop, human gate for irreversible actions), the Top-100 summary, the roadmap below.
7. **Ownership guard:** add the VTID to `ALLOWED_VTID_PATTERN` in `scripts/ci/command-hub-ownership-guard.js` with the usual comment block.

## 4. Files in scope (vitana-platform)
New: `services/gateway/specs/loop-catalog-v1.json`, `services/gateway/specs/loop-catalog-external-refs.json`, `services/gateway/src/services/loop-catalog.ts`, `services/gateway/src/routes/autonomy-loops.ts`, `services/gateway/src/frontend/command-hub/loops-catalog.js`, `services/gateway/src/frontend/command-hub/loops-catalog.css`, `docs/autonomy/LOOP-ENGINEERING.md`, tests (§5), `docs/validation/<VTID>/plan-sparring.md`, `docs/validation/<VTID>/staging-tests.json`.
Changed: `services/gateway/src/index.ts` (one mount line), `services/gateway/src/frontend/command-hub/app.js` (nav entry + render hook), `services/gateway/src/frontend/command-hub/index.html` (`?v=` bumps + module tags), `services/gateway/src/frontend/command-hub/modules.json`, `services/gateway/src/frontend/command-hub/navigation-config.js` (generated), `services/gateway/specs/dev-screen-inventory-v1.json` (generated), `scripts/ci/command-hub-ownership-guard.js`.
Not touched: DB schema/migrations, auth middleware, LLM routing, `.github/workflows`, vitana-v1.

## 5. Test plan
- **Catalog unit test** `test/loop-catalog.test.ts`: exactly 100 entries; unique IDs; 10 domains × 10; every contract field non-empty; R2/R3 ⇒ human gate; R3 ⇒ autonomy ≤ L2; health-domain ⇒ claim verifier; LIVE/PARTIAL ⇒ `existing_ref` resolves: for `repo: vitana-platform`, `file`/`glob` must match on disk, `workflow` must match `.github/workflows/<ref>.yml`, `routine` must match `routines/<ref>.md`, and `table` must match a `create table|view` in `supabase/migrations`; for `repo: vitana-v1`, the ref is validated only against a committed allowlist `specs/loop-catalog-external-refs.json` (K01, K03, Q08 and the v1 pg_cron jobs), because the platform test cannot see the other repo; the count of external refs is asserted so they cannot grow silently; PARTIAL ⇒ `gap` set; totals match.
- **Service test**: signal attached for `run_plane` entries from a mocked `agent_runs_unified`; view error ⇒ `unavailable`, catalog still served; invalid spec ⇒ throws.
- **Route test** `test/routes/autonomy-loops.test.ts` (named after the route file): 401 without token, 403 without exafy_admin, 200 shape with admin; only GET registered.
- **Command Hub test** `test/command-hub/vtid-<VTID>-loops-screen.test.ts` with the existing `bundle.ts`/`fake-dom.ts` harness: Autonomy nav contains `loops`; render produces 100 rows from a fixture; filters narrow rows; detail panel shows the cycle; no inline handlers. Existing guardrails must stay green: `vtid-05072-bundle-manifest`, `t2-no-zero-caller-functions`, `t10-*` a11y, golden fingerprint, `vtid-04986-screen-inventory-in-sync`.
- **Local checks:** gateway `npm run typecheck`, lint, jest for the new and the command-hub tests, regen `--check`.
- **Staging (read-only, `staging-tests.json`):** `GET /command-hub/` contains `loops-catalog.js?v=<ver>`; `GET /command-hub/loops-catalog.js?v=<ver>` serves the render function; `GET /api/v1/autonomy/loops` unauthenticated returns 401 JSON (proves the route is live, not an HTML 404; no write, no sign-in). Authed shape is covered by the route test.
- No production test of any kind.

## 6. Roadmap after Phase 1 (each its own plan → sparring → VTID; not approved by this plan)
- **Phase 2 — Loop runtime contract:** promote the catalog to the DB by reusing `agents_registry` (already has `budget_per_run_usd`, `budget_per_day_usd`, `max_tier`, `eval_suite`, `enabled`) and `agent_runs`/`agent_run_steps` as the run ledger — no new `loop_tasks`/`agent_runs` tables; per-loop kill switch, budget enforcement and a shared stagnation detector; per-loop live signal instead of plane-level.
- **Phase 3 — Wave 1 loops:** supplier onboarding + feed normalization + claim scanner + media check + listing audit (S01/S02/S03/S06/C01), narrow first: one category, ≤ 20 SKUs per run, deterministic validators before LLM, human publish gate. Target: 80% of supplier rows normalized, validated and ready for approval without manual entry. Plus safety/cost loops M07, G04, G05, G10.
- **Phase 4 — Health safety before health loops:** H04 red-flag escalation and H10 claim verifier with eval sets, before any H-loop ships.
- **Phase 5 — Vitana health MVP loop:** check-in → summary → plan → recommendation → explicit approval → follow-up → outcome (H01, H05, H06, H09), consent-gated and auditable.
<!-- plan:end -->

---
## Planner responses — round 1
- **F1 [major] — ACCEPTED (modified).** The new route uses the already-exported shared middleware `requireAuth` + `requireExafyAdmin` (`middleware/auth-supabase-jwt.ts:384,462`). It does not add a sixth local copy, and it does not export from `autonomy-pulse.ts`. De-duplicating the five existing local copies is out of scope; the smallest change leaves them alone. Plan §3.3 updated.
- **F2 [major] — ACCEPTED.** The JS is `bundle` `kind: "module"`, placed before `app.js`, and exposes `window.LoopsCatalog`. The `app.js` hook guards the global like `app.js:1501-1503`. Plan §3.4 updated.
- **F3 [minor] — ACCEPTED.** The CSS `<link>` gets its own `?v=`. Plan §3.4 updated.
- **F4 [minor] — ACCEPTED.** It is a separate router mounted at `/api/v1/autonomy` with the single path `/loops`. This matches the existing two-router pattern at `index.ts:895-896`. Plan §3.3 updated.
- **F5 [major] — ACCEPTED.** `existing_ref` is now typed (`repo`, `kind`, `ref`) with a resolution rule per kind. vitana-v1 refs go through a committed allowlist, and the allowlist count is asserted. Plan §1, §4 and §5 updated.
- **F6 [minor] — ACCEPTED.** Noted in §3.4 that this is the 7th tab and the screen is desktop-first.
- **F7 [minor] — ACCEPTED.** Stated in §3.5 that these files are generated only, never hand-edited, and that `--check` must pass.
- **F8 [minor] — ACCEPTED.** The meta line is reworded.
- **Q1:** See F5: typed `repo` field plus the external allowlist.
- **Q2:** `run_plane` ∈ {`dev_autopilot`, `community_autopilot`, `self_healing`} (the view's `plane` column). Mapping: E01, E02, E03 → `dev_autopilot`; P01, P02 → `self_healing`; M01 → `community_autopilot`. All other loops have no `run_plane` and show "no run ledger yet". Phase 2 gives them per-loop signals.
- **Q3:** One unpaginated payload of about 100 KB. Stated in §3.3.

## Partner round 2
F1–F8 are closed. One new finding:
- F9 [minor]: the shared `requireExafyAdmin` has no `X-Gateway-Internal` bypass, unlike `autonomy-pulse.ts:41-43`.

## Planner responses — round 2
- **F9 [minor] — ACKNOWLEDGED, no change.** The only consumer is the Command Hub browser, which always sends a JWT. Not adding an internal bypass keeps this read-only endpoint stricter.

## Verdict
**CONVERGED** after 2 rounds (standard class, cap 3). No blocker or major is open or disputed.
