# Plan — commerce-step-owner

Follow-up 2 of VTID-05204: every open onboarding step says who can finish it — the supplier's AI assistant, the
supplier themselves, or Vitanaland — and the supplier screen's "Still needed" groups the open steps the same way.

<!-- plan:begin -->
## Goal (owner, 2026-10-15 and 2026-10-19)
Supplier onboarding is AI-led; manual is the fallback (vitana-v1 `CLAUDE.md` → "Commerce UX contract",
`exafyltd/vitana-v1@704b5def4:CLAUDE.md:362`). Backend Commerce rule 9
(`exafyltd/vitana-platform@3cbe82e4c:.claude/rules/backend.md:1121`) requires that "any new or changed status
field must say, per open step, whether the system/AI can complete it or a human must". The VTID-05204 sparring
record reserved this for follow-up 2: the checklist "has no per-step machine/human flag; follow-up 2 is where it gets
added" (`docs/validation/VTID-05204/plan-sparring.md:80` and `:140`). VTID-05209 left it out of scope
(`docs/validation/VTID-05209/plan-sparring.md:119`).

Change class: **standard** (gateway pure checklist function + Commerce MCP status shape in vitana-platform; one
supplier screen + i18n in vitana-v1). No migration, no new route, no write path. Both repos deploy → change suites,
STAGING-VERIFY and Gate 2.

Pinned refs: `exafyltd/vitana-platform@3cbe82e4c`, `exafyltd/vitana-v1@704b5def4`.

## Today (verified in code)
- The checklist is built by the pure `buildChecklist` (`services/gateway/src/services/partner-onboarding-checklist.ts:207`);
  each step is `{ key, required, status, missing?, detail? }` (`:159`, built at `:282`). Statuses: `todo`,
  `in_progress`, `done`, `failed`, `not_required` (`:35`). It is returned unchanged as `checklist` by
  `GET /api/v1/partner-onboarding/:orgId` (`routes/partner-onboarding.ts:225`, `:231`) and by the Commerce MCP
  service (`services/partner-onboarding-service.ts:119`).
- Who can do a step exists only inside the Commerce MCP, as two unrelated tables: `ON_SCREEN_STEPS` (terms, dpa,
  billing_mandate, results_channel, tracking_test — `services/commerce-mcp.ts:323`) and `STEP_TOOLS` (company,
  verification, catalogue, mapping — `:325`). `shapeStatus` (`:440`) marks the first set `done_on_vitanaland`
  (`:474`); `nextAction` (`:361`) names a tool or a `supplier_action`. The REST response and the supplier screen
  carry neither.
- Verification is not one owner. Its stored row keeps the open checks as codes in `detail.missing`
  (`services/partner-onboarding-service.ts:727`), from `MISSING_CODE` (`services/partner-verification.ts:47`):
  `email_not_verified` and `domain_proof` need the supplier (confirm the email; put the DNS TXT record or meta tag on
  the site); `vat_id`, `vat_invalid`, `*_check_unavailable` and `facts_changed` are fixed or re-run by the assistant
  (`update_business`, `check_verification`); `business_verification*` and `licence*` have no provider yet and are
  completed by a Vitanaland admin approval (`services/partner-review.ts:221`). A reviewer's request for changes sets
  the step to `todo` with `detail.review_note` (`partner-review.ts:275`).
- The supplier screen lists open steps in one undifferentiated "Still needed" box: `openSteps`
  (`vitana-v1 src/components/commerce/SetupHub.tsx:109`) keeps required steps whose status is `todo` or `failed`
  (`:112`) and renders them at `:449`. A required step that is `in_progress` (company partly filled, verification
  waiting) is not listed at all.

## Change 1 — vitana-platform (gateway)
1. `partner-onboarding-checklist.ts`: `export type StepOwner = 'assistant' | 'supplier' | 'vitanaland'` and a pure
   `export function stepOwner(step: ChecklistStep): StepOwner | null`. Null for a step that is `done` or
   `not_required`, or not required. Otherwise:
   - `company`, `catalogue` (incl. `catalogue_fixes`), `mapping` → `assistant`. `mapping` with a shop connection
     stays `assistant`: `connect_store` starts or reuses it and already returns any consent screen as
     `supplier_action` (`commerce-mcp.ts:587`).
   - `terms`, `dpa`, `billing_mandate`, `results_channel`, `tracking_test`, `team` → `supplier`.
   - `verification`, first match wins:
     1. `step.missing` contains `facts_changed` → `assistant` (re-run `check_verification` on the new facts).
        `step.detail.missing` is then ignored: `buildChecklist` keeps the stored row's `detail` when the result is
        stale (`partner-onboarding-checklist.ts:258`–`:267`), so its codes describe the old facts.
     2. `step.detail.review_note` present → `supplier`.
     3. Otherwise the codes in `step.missing` ∪ `step.detail.missing`: any of `email_not_verified`, `domain_proof`
        → `supplier`; else any of `website` (prepended when the org has no website host,
        `partner-onboarding-service.ts:720`), `vat_id`, `vat_invalid`, `email_check_unavailable`,
        `domain_check_unavailable`, `vat_check_unavailable` → `assistant` (`update_business`, `check_verification`);
        else (`business_verification*`, `licence*`, or `in_progress` with no code) → `vitanaland`.
     4. An unknown code counts as `supplier`, so a new check never silently claims the AI can do it.
   - `account` is always `done` today; it maps to `supplier` if that ever changes.
2. `buildChecklist` sets `step.owner = stepOwner(step)` on every open required step (additive field; no other field
   changes; no gateway test compares a whole step object, so existing suites stay as they are). Every response that
   carries `checklist` inherits it — `GET /:orgId`, the terms-accept and submit answers (`orgState`,
   `partner-onboarding-service.ts:119`, and the 409 `SUBMIT_PREREQUISITES_MISSING` body, `:417`) — and so does every
   Commerce MCP status.
3. `commerce-mcp.ts`: one source for the split — `ON_SCREEN_STEPS` becomes "steps whose fixed owner is
   `supplier`", derived from the checklist module, so the two lists cannot drift. `shapeStatus` adds `owner` to each
   open step and to `next_action`; `done_on_vitanaland`, `link`, `tool` and `supplier_action` stay byte for byte.
   `next_action.owner` is the owner of `next_action.step`, with the cases `nextAction` (`commerce-mcp.ts:361`)
   produces outside the checklist: the typeless pseudo-step `business_type` (`:370`) → `assistant`
   (`update_business`); no step but tool `submit_for_verification` (`:380`, checklist complete) → `assistant` (it
   still needs the supplier's `confirmed: true`, as today); no step and no tool → `null`.
   One `INSTRUCTIONS` sentence (`:61`): "Each open step has an owner: assistant (you can do it now), supplier (only
   the supplier can — give them the link), vitanaland (nothing to do; Vitanaland is reviewing it)."
4. No new route, no migration, no write, no change to lifecycle, submit, verification or terms logic.

## Change 2 — vitana-v1 (frontend)
1. `SetupHub.tsx`: `parseChecklist` (`:77`) reads `owner` (anything else → `supplier`). `openSteps` (`:109`)
   lists every required step that is not `done` or `not_required` (adds `in_progress`), each with its owner.
2. "Still needed" (`:449`) shows up to three short groups, in this order, each only when it has items:
   - **"Only you can do this"** (`supplier`) — first, because nothing else unblocks it;
   - **"Your AI assistant can do this"** (`assistant`), with one line: *Ask your assistant: "Finish setting up my
     business on Vitanaland."* Shown only when the Commerce MCP is reachable (the existing `fetchMcpReady`,
     `src/lib/commerce-mcp.ts:62`, already used by `CommercePortal.tsx:212`); otherwise these items join the
     supplier group, so the screen never promises an assistant that cannot connect;
   - **"Vitanaland is checking"** (`vitanaland`) — no action.
   Labels stay the existing `OPEN_STEP_LABEL` texts (`:122`). No new button, field, dialog or step; the rows above
   and Submit/Resubmit are unchanged. Plain words only (no step keys, IDs or states — UX contract).
3. i18n: four new keys (three group titles, one hint) in `src/i18n/de/screens.json` first, then `en` and the other
   nine locales (ar es fr pl pt ru sr tr zh), as VTID-05209 did; `npm run i18n:inventory`.
4. The PR carries the "UX acceptance" section: user steps unchanged; required fields none; anything asked that the AI
   could infer: none; next action always visible (supplier group first); friction down (the supplier sees what they
   need not do).

## Order and release
Gateway lane first, frontend lane after it is on staging (`depends_on`). The frontend tolerates a checklist without
`owner` (old gateway): every item goes to the supplier group, which is today's single list, so neither repo can break
the other. The gateway half ships to production with the next gateway release, currently blocked by rule 47 on two
non-Commerce commits (`715cbb94`, `229b38b2`; STAGING-VERIFY run 39257075062) — not this plan's to fix.

## Out of scope
The assistant registering a business end to end; switching `COMMERCE_MCP_CHATGPT` or `COMMERCE_AI_SETUP_ENABLED` on
in production; `experience` over MCP; detecting whether this supplier has an assistant connected (grants are per
OAuth client, `services/ai-connection-grants.ts`); any change to `nextAction`'s choice of tool; terms, verification
rules, lifecycle or submit.

## Tests
- Gateway (Jest, mocked Supabase): `stepOwner` table for every step key and every verification code incl. `website`,
  an unknown code → `supplier` and `review_note` → `supplier`; a stale row (`facts_changed` with old
  `email_not_verified` still in `detail.missing`) → `assistant`; `next_action.owner` for the typeless, complete and
  empty cases; `buildChecklist` sets `owner` only on open required steps and
  changes nothing else (existing checklist suites unchanged apart from the added field); `shapeStatus` carries
  `owner` on steps and `next_action` with `done_on_vitanaland`/`tool`/`supplier_action` unchanged; every
  `ON_SCREEN_STEPS` key has fixed owner `supplier` and every `STEP_TOOLS` key except `verification` has `assistant`.
- Frontend (Vitest): grouping and order; `in_progress` now listed; missing or unknown `owner` → supplier group; MCP
  not reachable → no assistant group; i18n keys present in all 11 locales.
- Change suites (`docs/validation/<VTID>/staging-tests.json`, rule 47): gateway — `GET /partner-onboarding/<uuid>`
  is mounted and answers 401 JSON, plus the Jest suites as `existing`; frontend — a read-only Playwright spec at
  390×844 and 1280×900 with a demo business served in the browser (any write recorded and aborted, as VTID-05209's
  staging spec), plus the Vitest suites. Staging shares the production database, so nothing signed-in writes.

## Lanes
- `gateway-step-owner` (vitana-platform) — executor kiro, seat `exafy` (area platform), reviewer `exafyltd`.
- `frontend-still-needed` (vitana-v1) — executor kiro, seat `exafyltd` (area frontend), reviewer `exafy`;
  depends on `gateway-step-owner`.
One VTID per lane, allocated by PLAN-SPAR on convergence.

## Risks
- A wrong verification mapping tells a supplier the AI can do something it cannot. Mitigated: unknown codes and
  review notes default to `supplier`; the table is unit-tested per code; `next_action` is unchanged.
- An MCP client that rejects unknown fields: none do (fields were added the same way in VTID-05209, VTID-04953).
- More "Still needed" items (adds `in_progress`): each is a step that is genuinely open, now with its owner.
<!-- plan:end -->
