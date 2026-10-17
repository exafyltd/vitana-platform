# Internal review — mt-track-s (Track S security hotfixes S-A..S-L + Health Phase 0 WS10)

Reviewer: independent adversarial internal reviewer (fresh pass, round 3). Date: 2026-10-15.
Scope reviewed: `plan.md`, `requirements.md`, `design.md`, `tasks.md`, `handoff.md`,
`lanes/s-j-route-inventory.md`. Rubric: `BATCH-BRIEF.md` ## Internal review + `CROSS-SPEC-DECISIONS.md`.
Method: every premise re-verified against **current** code with `file:line`; the `queue.mjs` validators
(`parseFrontMatter` + `validatePlan`/`validateLane`) run on `handoff.md` and the lane file; targeted spot-checks
only — no suite re-runs. The spec is on its third draft; the prior INTERNAL-REVIEW closed a MEDIUM (config.toml)
and a HIGH (the collected vitest suite). This pass re-verifies those fixes landed and re-opens nothing it finds sound.

## Verdict summary
**APPROVED.** No HIGH or MEDIUM finding. The "16 of 17 closed, 1 open residual (S-J)" accounting is accurate
against current code; the single open lane is correctly scoped to the dead-`linkedin-import` removal plus a node
inventory gate; the two companion edits the removal needs (orphaned `config.toml` registration and the collected
vitest suite) are now in the lane `paths` and in `tasks.md`, both identical; both machine validators return zero
errors; no DONE work or sibling spec is duplicated; CROSS-SPEC-DECISIONS names no ruling for this slug. The only
findings are three NITs about stale `file:line` citations and a doc-comment reference — none block.

---

## Verified assumptions (checked against current code)

1. **S-J OPEN residual is real** — `vitana-v1/supabase/functions/linkedin-import/index.ts` still ships, imports
   `requireUser, forbidden` from `../_shared/caller-auth.ts` (`:4`) and carries the VTID-05049 "nothing in the app
   calls this function (social-media-import replaced it) … flagged for removal in the Track S route inventory (S-J)"
   comment (`:6-8`). The deletion is the correct action. **Verified.**
2. **No runtime consumer of `linkedin-import`** — a tree-wide search of `vitana-v1/src/**`, `vitana-v1/supabase/**`
   and `vitana-platform/services/**` (excluding `.worktrees`/`node_modules`) for `linkedin-import` /
   `functions.invoke('linkedin-import'` finds only the spec docs and the one collected test file. Deletion is safe.
   **Verified.**
3. **vitest include glob** — `vitana-v1/vitest.config.ts` sets `include: ['src/**/*.test.{ts,tsx}']` (actual
   **line 20**, the plan/tasks/lane cite `:22` — see NIT-3). A test under `supabase/functions/**` is genuinely never
   collected, so the plan's choice of a node check script over a vitest `.test.ts` is **correct**. **Verified.**
4. **npm test chain / repo convention** — `vitana-v1/package.json` `"test"` is exactly
   `node scripts/check-edge-data-client.mjs && node scripts/check-realtime-helper.mjs && vitest run`; both
   `scripts/check-edge-data-client.mjs` and `scripts/check-realtime-helper.mjs` exist. Wiring a third
   `node scripts/check-edge-function-auth.mjs` into that chain matches the established pattern exactly. **Verified.**
5. **`config.toml` orphan is real and in scope** — `vitana-v1/supabase/config.toml` has a
   `[functions.linkedin-import]` block (`verify_jwt = true`) at **line 72** (plan/design cite `:72-74`; the block is
   two lines, 72-73 — immaterial). Round 2 added `supabase/config.toml` to the lane `paths` and to `tasks.md`
   "Allowed paths:", and T2 removes the block. The earlier MEDIUM is **closed**. **Verified.**
6. **The collected vitest suite is real and in scope** — `vitana-v1/src/lib/edge-functions-caller-identity.s4.test.ts`
   is under `src/**`, so vitest collects it. It references `linkedin-import` at lines **6** (header docstring comment),
   **77** (the `['linkedin-import', 'social-media-import', 'queue-campaign-recipients', 'send-welcome-discount',
   'fetch-user-context']` loop that calls `fn(name)` → `readFileSync`), **90** (the `['linkedin-import',
   'social-media-import']` profile-import loop, evaluated in the describe body via `handler(fn(name))`), **107-108**
   (`it('linkedin-import is flagged for removal')` → `fn('linkedin-import')`), and **272** (the
   `expect(readers).toEqual(expect.arrayContaining(['linkedin-import', 'social-media-import', 'fetch-user-context']))`
   scan assertion). After deletion `readFileSync` throws at collection for 77/90/107 and the `arrayContaining` at 272
   fails. Round 2 added this file to `paths` + `tasks.md` and T2a drops `linkedin-import` from those sites while keeping
   `social-media-import`/`fetch-user-context`. The earlier HIGH is **closed**. (Citation nit: the plan/tasks label the
   scan assertion `:198` — it is actually `:272`; see NIT-1. The site is correctly identified, only the line is wrong.)
   **Verified.**
7. **S-A / S-J debug routes** — `vitana-platform/services/gateway/src/routes/orb-live.ts` has `/debug/tts` at
   `:15513` and `/debug/context-bootstrap` at `:15554` (both exafy-admin gated, plan cites both exactly). **Verified.**
8. **S-K** — `vitana-platform/services/gateway/src/routes/billing.ts` reads all `tenant_settings` rows via the
   repository and aggregates per tenant with no unscoped `.maybeSingle()`; the premise shape matches. **Verified
   (spot-check).**
9. **queue.mjs validators** — ran `parseFrontMatter` then `validatePlan(fm, 'mt-track-s')` on `handoff.md` and
   `validateLane(fm, 'mt-track-s', 's-j-route-inventory', …)` on the lane file. Both returned `[]` (zero errors).
   handoff fm = {slug, author:kiro, author_seat:hotmail, executor:kiro, next_actor:kiro, state:drafted, updated};
   state `drafted` so no `sparring_record`/`vtids` required yet. Lane fm has `executor:kiro`, `seat:exafyltd`,
   `reviewer_seat:jtadic` (≠ seat), `paths` (6 entries), `depends_on:[]`, `state:ready`, `next_actor:owner`; no
   `paths` glob reaches a governance path (`globTouchesGovernance` clean for all six), so `executor: kiro` is legal.
   **Verified — no validator error (any error would have been HIGH).**
10. **Paths narrow AND complete** — the six lane `paths` (`supabase/functions/linkedin-import/**`,
    `supabase/config.toml`, `src/lib/edge-functions-caller-identity.s4.test.ts`, `scripts/check-edge-function-auth.mjs`,
    `package.json`, `docs/validation/**`) cover every file T1–T4 touch, and are byte-identical to `tasks.md`
    "Allowed paths:". No file a task changes is missing; no path is broader than needed. **Verified.**
11. **Governance / executor split** — none of the lane's paths is a governance path (governance = `.github/**`,
    `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`, `CLAUDE.md`,
    `docs/programs/areas.yaml`). `package.json`, `scripts/check-edge-function-auth.mjs` and `supabase/config.toml` are
    not among them, so `executor: kiro` is correct (confirmed by the validator's `globTouchesGovernance` check).
    **Verified.**
12. **Seat / area / reviewer** — `docs/programs/areas.yaml`: the lane's work (`supabase/functions/**`, `scripts/**`,
    `package.json`, `supabase/config.toml`, one `src/lib` test) is covered by no specific area, so the `frontend`
    catch-all (seat `exafyltd`) is the right assignment; `jtadic` is a valid distinct seat for `reviewer_seat`.
    **Verified.**
13. **Lane sizing** — one lane = one VTID, code-only, well under 2–4 PRs; no DB change so the §4.7 DB/code split is
    N/A; not merged across repos (spec folder in vitana-platform per collaboration §2, PR targets vitana-v1 only);
    `reviewer_seat ≠ seat`. **Verified.**
14. **depends_on** — empty, correct for a single-lane spec; the validator accepts it. **Verified.**
15. **Migrations / reservation** — none in this slice; the reserved range `20261101010000`–`20261101015959`
    (NN=01) is recorded only to reserve it and is referenced by no other spec. CROSS-SPEC-DECISIONS's migration-order
    ruling concerns specs 07 (C3 at `…070160`) and does not touch this range. No conflict. **Verified.**
16. **Dark-by-default** — the plan names the one exception explicitly (deleting an uncalled function + adding a test
    is not member-reachable, so it ships without a flag), matching the mt-spec example's exception shape. **Present.**
17. **Standing rules present** — never test against production (31/31b/48), staging read-only, 42c/42e/42h untouched
    (no support/operator/role surface), no App.tsx route (so nav-registry / screen-manifest / parity-ledger
    untouched), What's New correctly omitted (dead-code removal + test, not a finished member feature). **Present.**
18. **No DONE / cross-spec duplication** — no other `.kiro/specs/**` file references `linkedin-import` or
    `check-edge-function-auth`; CROSS-SPEC-DECISIONS names no ruling for `mt-track-s`; the gateway-side generated
    route inventory and realtime-channel RLS are correctly deferred to WS0 (M0) and placed below `plan:end` as a
    non-blocking Open question. **Verified.**

## Unverified / wrong assumptions

- The CLOSED-item premises not independently opened line-by-line this pass (S-B/S-D migration internals, S-F
  audit-log repository internals, S-G invitations, S-I all five header sites, S-L partner-health, S-M lockdown
  migration internals, WS10 token/webhook internals) were spot-trusted after confirming S-A/S-J debug routes,
  S-H (`linkedin-import` + `social-media-import`), S-K billing and the S-J residual against current code and finding
  each accurate at the cited shape. No contradicting evidence surfaced. None was found wrong.

---

## Findings

### NIT-1 — Wrong line number for the `arrayContaining` assertion in the collected suite
Where: `plan.md` ## Fix and ## Risks, `requirements.md` R1.4, `design.md`, `tasks.md` T2a, `lanes/s-j-route-inventory.md`.
All of them cite the `arrayContaining([...])` scan assertion at `:198`. The assertion is actually at **line 272**
of `src/lib/edge-functions-caller-identity.s4.test.ts`; line 198 sits inside the unrelated `send-welcome-discount`
describe block. The other three citations (`:77`, `:90`, `:107-110`) are correct. The site is correctly identified
in prose ("the `arrayContaining([...])` scan assertion"), so the implementer will find it regardless; only the number
is stale. Non-blocking.
Fix: change `:198` to `:272` in all five files (or drop the line number and keep the prose description).

### NIT-2 — The header docstring at `:6` also names `linkedin-import`; T2a scopes only the "four assertions"
Where: `tasks.md` T2a / `plan.md` ## Fix. The file's header comment at **line 6**
("let anyone write any member's profile (linkedin-import, social-media-import)") references the function too. It is
a doc comment, not an assertion, so leaving it does not break `npm test` — but a route-inventory lane whose point is
to remove a dead reference leaves a dangling mention of a deleted function in the test's own header. Non-blocking.
Fix: have T2a also update the line-6 header comment to drop `linkedin-import` (or state in the task that the header
comment is intentionally kept as historical context for the VTID-05049 regression it documents).

### NIT-3 — vitest `include` glob cited as `:22`, actually `:20`
Where: `plan.md` ## Fix / ## Tests, `requirements.md` R2.3, `tasks.md`, `lanes/s-j-route-inventory.md`. They cite
`vitest.config.ts:22` for the `include: ['src/**/*.test.{ts,tsx}']` line; it is at **line 20**. The glob value and
the argument built on it are correct — only the line number drifted. Non-blocking.
Fix: change `:22` to `:20`.

---

## Notes on non-findings (for the record, not blocking)
- The inventory gate's "fails if `linkedin-import` reappears without a gate" is internally consistent: the current
  `linkedin-import` does gate via `requireUser`, but it is being deleted, so the regression the gate guards is a
  *re-added ungated* copy, not today's file.
- The round-2 removal of the staging edge-function invoke (a POST the read-only network guard aborts) is correct;
  ## Staging verification now leans on the CI inventory gate + the updated Vitest suite as the authoritative proof,
  as rule 48 intends. The earlier LOW is closed.
- The `## Open questions for sparring` item (realtime-channel RLS belongs to WS0, not Track S) is correctly placed
  below `plan:end` and is explicitly non-blocking per the brief.
- The lane's `area: frontend` paths glob in `areas.yaml` is only `src/**`, while the lane legitimately touches files
  outside `src/**`. `area` is a seat-assignment hint, not a scope constraint (scope is the `paths` block, enforced by
  the Lane-scope check), so this is not a defect.
