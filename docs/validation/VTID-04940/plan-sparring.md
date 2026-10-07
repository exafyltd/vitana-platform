# Plan sparring record — VTID-04940 (item 3 of the plan sparred under VTID-04938)

Sparred and owner-approved plan: `docs/validation/VTID-04938/plan-sparring.md` (plan hash `4f2e36ed66177ffaf3b1b06633b19e63442d12c3da7e16e58c39fed3ff3c5224`, CONVERGED after 2 rounds). Owner instruction 2026-10-07: "approved, run item 3".

## Narrowing found while implementing (no new risk; recorded, not re-sparred)
Item 3 listed a new read-only `get_business` tool "(company details, checklist, terms link)". `get_onboarding_status` called with an `organization_id` already returns exactly that (`shapeStatus`: company details, checklist steps, ready-to-submit, portal link), so a second tool would duplicate it, enlarge the surface the Directory reviewers must read, and add nothing. Not added. Everything else in item 3 is delivered: the supplier-data envelope with the non-instruction note on every tool that returns supplier text, length caps and control/bidi stripping, a list size cap, and tests pinning tool names, titles and annotations. `openWorldHint` stays out of scope as sparred.

## Verdict
Scope narrowed by one redundant tool; owner informed in chat.
