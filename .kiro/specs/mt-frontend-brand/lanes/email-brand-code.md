---
lane: email-brand-code
state: ready
next_actor: kiro
depends_on: [email-brand-db]
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
paths:
  - supabase/functions/voucher-send-email/index.ts
  - supabase/functions/send-appointment-email/index.ts
  - supabase/functions/send-appointment-reminder/index.ts
  - supabase/functions/send-welcome-discount/index.ts
  - supabase/functions/og-share/index.ts
  - supabase/functions/og-event/index.ts
  - supabase/functions/og-campaign/index.ts
  - supabase/functions/og-short/index.ts
  - supabase/functions/_shared/tenant-brand.ts
  - supabase/functions/_shared/tenant-brand.test.ts
updated: 2026-10-19T20:32Z
vtid: VTID-05244
---
# email-brand-code — edge fns & OG workers read branding by tenant (repo vitana-v1)

Plan: `.kiro/specs/mt-frontend-brand/plan.md` and the `email-brand-code` section of `tasks.md`
(EC1–EC4, allowed paths, acceptance). Design: `design.md`.

**Held until PLAN-SPAR allocates this lane's VTID** (`next_actor: owner`); PLAN-SPAR flips it to
`kiro`. **Build only after `email-brand-db` is applied** (depends_on): the helper it selects
from must exist. Each resolver falls back to Maxina's values when a tenant has none.

Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`/another lane, no merge/approve/deploy/dispatch, no Supabase/AWS writes — in
particular NO `deploy_edge_function`; the edge-fn code change is a file in the PR, deployed by
the normal pipeline. The Supabase Auth email templates + redirect allowlist are owner-only
Supabase-dashboard steps — write them as a runbook in `docs/validation/<vtid>/runbook-supabase.md`,
do NOT script or apply them. No email is sent from any test. The lane adds its own
`docs/validation/<vtid>/`. Branch `kiro/mt-frontend-brand/email-brand-code`; PR title
`VTID-xxxxx (mt-frontend-brand/email-brand-code): …`; trailers `Collab-Session`/`Collab-Lane`.
On PR open: `state: in-review`, `next_actor: kiro`, `pr: <url>`, log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Premises: hardcoded sender/brand in `voucher-send-email/index.ts:265,344,359`,
`send-appointment-email/index.ts:262`, siblings; OG `VITANA` site name in `og-share/index.ts:91,96,97`
and the other og-* workers. depends_on `email-brand-db`. Reviewer seat `jtadic` (≠ `exafyltd`).

### 2026-10-19T20:32Z · ci-plan-spar · ready (VTID allocated)
VTID-05244 allocated after policy approval (converged-auto-v1).
