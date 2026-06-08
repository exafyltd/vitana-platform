# VCAOP — GO-LIVE / Environment Setup Runbook

> How to take the (complete, mock-first) VCAOP build to **actively usable**, in the
> order that gets you earning fastest. **Chosen path: affiliate/demand first; eBay
> as the first real integration.** Honest framing: account *creation* with major
> providers is human-gated by design (KYB / accept-ToS / CAPTCHA are human, by law
> and provider ToS). VCAOP automates everything around that — data prep, long-tail
> form-fill, operations, attribution, rewards, monitoring, self-healing. Your job is
> the legal checkpoints; the platform does the rest.

Legend: 🤖 = I (the agent) do it autonomously once unblocked · 🧑 = you / a human.

---

## Phase 0 — Provision the dev environment (THE unblock; everything waits on this)

| # | Task | Who | Notes |
|---|------|-----|-------|
| 0.1 | Re-authorize the **GitHub MCP** token | 🧑 | expired — blocks PR/CI reads |
| 0.2 | Create a **dev Supabase** project (or branch) | 🧑 | note the project URL + service-role key |
| 0.3 | Create a **`vcaop-api-dev` Cloud Run** service slot in `lovable-vitana-vers1` / `us-central1` | 🧑 | no traffic yet; the pipeline deploys it |
| 0.4 | Configure **WIF** (workload identity federation) for GitHub Actions → GCP deploy | 🧑 | provides `VCAOP_WIF_PROVIDER`, `VCAOP_DEPLOY_SA` |
| 0.5 | Set GitHub **secrets**: `VCAOP_WIF_PROVIDER`, `VCAOP_DEPLOY_SA`; **repo var** `VCAOP_DEV_DEPLOY_ENABLED=true` | 🧑 | un-gates the deploy job |
| 0.6 | Put dev DB creds in **Secret Manager** (NOT in repo): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `DATABASE_URL` | 🧑 | referenced by the gateway/migrations |
| 0.7 | **Merge PR #2585** to `main` | 🧑 | lands the foundation; activates health crons |

**Acceptance:** GitHub MCP works again; `vars.VCAOP_DEV_DEPLOY_ENABLED=true`; the three secrets exist; PR merged.

---

## Phase 1 — Land the foundation live  🤖 (once Phase 0 done)

| # | Task | Who |
|---|------|-----|
| 1.1 | Apply the VCAOP migration to dev Supabase; **verify down-path** on a scratch copy | 🤖 |
| 1.2 | Apply the RLS migration; verify the role matrix against the live dev DB | 🤖 |
| 1.3 | **Mount the VCAOP router into the Gateway** with the Prisma repo (`writeWithEvent` for same-tx OASIS) — see §Gateway-mount below | 🤖 |
| 1.4 | Deploy `vcaop-api-dev` via the pipeline (`--source`, dev caps) | 🤖 |
| 1.5 | Smoke: `curl /alive` (JSON 200); `GET /api/v1/vcaop/openapi.json`; authz matrix over HTTP | 🤖 |
| 1.6 | Point the in-process health probe at live signals; wire self-healing primitives (rollback revision / down-migration / reseed) to real impls | 🤖 |

**Acceptance:** dev API live; migrations applied + reversible; health probe green against live; self-healing primitives real.

---

## Phase 2 — Exafy canonical identity + KYB (one-time unlock)  🧑+🤖

| # | Task | Who |
|---|------|-----|
| 2.1 | Seed the single `business_identity` (legal name, entity, reg no., VAT/EORI, registered address, responsible officer) | 🤖 (data) / 🧑 (values) |
| 2.2 | Complete the **KYB human-task** (officer identity, tax, docs) | 🧑 |
| 2.3 | Artifacts vaulted + marked reusable (automatic — KYB-FLOW-0001) | 🤖 |

**Acceptance:** Exafy identity verified once; artifacts reused by every later provider (no repeat KYB).

---

## Phase 3 — Affiliate/demand first (fastest to "earning")  🤖+🧑

Goal: breadth + users earning rewards quickly. Two tracks in parallel:

### 3a. Aggregator (inherits ~50k merchants in one integration)
1. 🧑 Choose + sign up with ONE aggregator (Skimlinks / Sovrn / Wildfire-class); supply API key via Secret Manager.
2. 🤖 Implement the real `AggregatorClient` behind `src/rewards/aggregator.ts` (verify docs per Sec 0.8 → DECISIONS).
3. 🤖 Wire postback ingestion → `commission_event` → `rewards_ledger` against the live endpoint; verify a sandbox postback credits a test user, and a reversal claws back.

### 3b. eBay (first direct integration — eBay Partner Network + sandbox proof)
1. 🧑 Apply to **eBay Partner Network** (EPN) — the direct affiliate program (human-gated; the platform generates the application + tax/bank tasks).
2. 🧑 Create an **eBay developer sandbox** app; supply sandbox OAuth creds via Secret Manager.
3. 🤖 Verify eBay API + OAuth docs (Sec 0.8 → record VER-*), then implement the eBay `OAuthClient`/`ApiClient` behind the existing connector interface.
4. 🤖 Run the loop end-to-end on **sandbox**: discover → (human EPN approval) → verify → operate (e.g. fetch deals) → mint per-user SubID → attribute a sandbox order → credit wallet → confirm → reversal.
5. 🧑 Approve the EPN application + production credentials when ready → flip eBay from sandbox to live.

**Acceptance:** a real (sandbox→live) merchant route earns a per-user reward end-to-end; FTC disclosure shown; reversal claws back.

---

## Phase 4 — Scale to hundreds  🤖+🧑

- **Direct programs (top ~10):** Amazon Associates, Awin, CJ, Impact, Rakuten, Booking/Expedia — each via the direct-registration human-task path (apply + tax + bank), then the agent operates.
- **Supply side (Exafy holds accounts):** Amazon SP-API, eBay marketplace, Walmart, Shopify, Etsy — API-class first; human KYB/register, agent operates.
- **Loyalty:** consented read-only links, official APIs only.
- **Long tail → hundreds:** each new provider = (1) add a conservative policy seed (default-deny until set), (2) verify vendor docs (Sec 0.8), (3) implement the adapter behind the existing `Connector` interface, (4) human KYB/register where required, (5) agent operates + monitors. The aggregator already covers the demand-side long tail (~50k merchants) without per-merchant accounts.

---

## Secrets / config reference (all by reference; never in repo)

| Key | Where | Purpose |
|-----|-------|---------|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `DATABASE_URL` | Secret Manager | dev DB + migrations |
| `VCAOP_WIF_PROVIDER`, `VCAOP_DEPLOY_SA` | GitHub secrets | WIF deploy |
| `VCAOP_DEV_DEPLOY_ENABLED` | GitHub repo var = `true` | un-gate deploy job |
| `AGGREGATOR_API_KEY` | Secret Manager | affiliate aggregator |
| `EBAY_OAUTH_CLIENT_ID/SECRET` (sandbox→prod) | Secret Manager | eBay connector (refs only; vault stores values) |

---

## Gateway-mount wiring (ready to apply in Phase 1)

Mount the VCAOP router into the existing Gateway Express app, backed by the Prisma
repo with same-tx OASIS writes:

```ts
// services/gateway/src/routes/vcaop.ts (new)
import { PrismaClient } from '@prisma/client';
import { buildVcaopRouter, PrismaRepository } from '@vitana/vcaop'; // workspace import
import { InMemoryOasisSink } from '@vitana/vcaop'; // replace with a Prisma-backed sink using writeWithEvent
import { seedPolicyEngine } from '@vitana/vcaop';
import { PolicyEngine } from '@vitana/vcaop';

const prisma = new PrismaClient();
export const vcaopRouter = buildVcaopRouter({
  repo: new PrismaRepository(prisma),
  oasis: /* Prisma OASIS sink using writeWithEvent for same-tx */ new InMemoryOasisSink(),
  policyEngine: seedPolicyEngine(new PolicyEngine()),
  authResolver: gatewayJwtAuthResolver, // map the Gateway's JWT/session → AuthContext
  source: 'gateway',
});
// in index.ts: app.use('/api/v1/vcaop', vcaopRouter);
```
Notes: replace the in-memory sink with one that calls `writeWithEvent` so each mutation
+ its OASIS event commit in one transaction; supply `gatewayJwtAuthResolver` from the
Gateway's existing auth middleware (maps role → `community|staff|admin|developer`).

---

## Per-provider integration template (repeat for each of the hundreds)

1. 🤖 Add a conservative **policy seed** (`provider-policy-seeds.ts`) — default-deny until set; major providers `registration_method: human_required`, `captcha_policy: human_only`.
2. 🤖 **Verify vendor docs** (Sec 0.8): API availability + auth model + ToS → record VER-* in `DECISIONS.md`. If unavailable/gated → mock + `BLOCKERS.md`.
3. 🤖 Implement the adapter (`ApiClient` / `OAuthClient` / browser flow / manual) behind the existing `Connector` interface. CI stays mock; live calls behind a flag + cost caps.
4. 🧑 Supply credentials via Secret Manager (vault stores values; DB holds refs only).
5. 🧑 Complete KYB/register (human-gated for majors); 🤖 agent does data prep + long-tail form-fill.
6. 🤖 Operate + monitor; health probe + self-healing cover regressions.

---

## What I do the moment Phase 0 lands
Apply + verify migrations on the real dev DB → mount the router in the Gateway with
the Prisma repo → deploy `vcaop-api-dev` → smoke-test live → then start Phase 3
(aggregator + eBay sandbox connector). I'll resume from `vcaop/CURRENT-STATE.md`.
