# Token Economy Architecture — Integrated Execution Plan

**Branch:** `claude/plan-token-economy-architecture-RiQZR` (both repos)
**Status:** Draft — sign-off received on four scope items (2026-04-17)
**Target:** VTNA public launch — end of Oct 2026

---

## 1. Locked doctrine

> VTNA is **not** a feature. It is the outcome of a system that generates real economic value now.

Now (2026) → build and prove a working CREDITS economy.
End of 2026 → tokenize a proven economy with a transparent Top-N allocation.

### Currency roles (non-negotiable)

| Currency | Role | Earned? | Purchasable? | Phase |
|---|---|---|---|---|
| **USD** | Fiat holding (Stripe Connect backing) | Never | Yes (deposit) | Phase B |
| **CREDITS** | Single reward + redemption currency | Yes | Yes (Phase B) | Live |
| **VTNA** | Security token | **Never** | Yes only | Oct 2026 |

**Critical:** VTNA is never minted by reward automation. Doing so would risk classifying reward emissions as a securities issuance. VTNA is **purchased only**, plus a one-time allocation event at launch based on eligibility rank.

---

## 2. System of record

- Single writer: `credit_wallet` / `debit_wallet` RPCs
- Single ledger: `wallet_transactions` with `transaction_type='reward'|'purchase'|'transfer'|'exchange'|'reseller_commission'`
- Single event bus: OASIS (events with deterministic `source_event_id` for idempotency)
- Single reward configuration: `REWARD_TABLE` in `services/gateway/src/types/automations.ts`
- Single user-facing surface for reward state: existing `/wallet` page (no new top-level routes)

**No parallel ledgers.** Scoring, contribution tiers, and VTNA eligibility are all **read-side aggregations** over the above.

---

## 3. Parallel work — boundaries

### Track A1 / A2 / A3 — Reward Expansion (in-flight, NOT on this branch)

Owns:
- `REWARD_TABLE` additions (referrals tiered, marketplace rewards, engagement, live rooms)
- New handlers: `marketplace-rewards.ts` (AP-1130..1137), `engagement-outcomes.ts` (AP-1120..1127), extended `sharing-growth.ts`
- Emitters in `live.ts`, voucher webhook, new `tickets.ts`, new `checkout.ts`
- Migrations 0–9 listed in the reward expansion plan (zero-reset, fx_rates_daily, reward_preview alignment, referrals, product_reviews, reward_partners, redeemable_rewards, redemption_orders, reward_fulfilment_events, discount_codes, activity_log trigger, REWARD_TABLE v2 seed)
- `vitana-v1/src/pages/wallet/Rewards.tsx` (replace mocks, add Redeem + My Redemptions tabs)
- Admin queue: `vitana-v1/src/pages/admin/redemptions/Queue.tsx`

**This branch does not touch any of the above.**

### This branch owns

- WS1 Business HUB wired into VTID-02000 as a seller channel
- WS2 Vitana Brain surfaces + reward emitters from Brain outputs
- WS3 Autopilot honest copy (shipped) + REWARD_TABLE request to Track A1
- WS4 Contribution engine + VTNA eligibility snapshots
- WS5 VTNA launch enablement (Oct 2026)

---

## 4. Workstreams

### WS1 — Business HUB as seller on VTID-02000 (May–Jun 2026)

**Principle:** Business HUB creators sell *through* the VTID-02000 marketplace, not a parallel system.

- Creator onboarding wizard → Stripe Connect account (leverage existing `services/gateway/src/routes/stripe-connect-webhook.ts`).
- "Create Service / Event / Package" popups in `BusinessHub.tsx` write to VTID-02000 `products` + `merchants` tables with `fulfilment_mode='stripe_connect'`.
- Earnings tab in `BusinessHub.tsx` driven by live `product_orders` scoped to `merchant_id = me` plus `wallet_transactions` rows with `transaction_type='reseller_commission'`.
- Campaign creation emits `marketplace.share.initiated` so creators' own promos qualify for the 1.50× attribution bonus + flat 200 CREDITS on a converted share (per Track A1).
- Replace placeholder Insights tabs (Earnings / Performance / Growth) with real queries against marketplace tables.

**Deliverable:** Creator earns real money on every marketplace order and sees it in Business HUB instantly.

---

### WS2 — Vitana Brain in the reward loop (Jun–Aug 2026)

**Principle:** The six intelligence services (`retrieval-router`, `context-pack-builder`, `orb-memory-bridge`, `d44-signal-detection-engine`, `d48-opportunity-surfacing-engine`, `d49-risk-mitigation-engine`) must *feed* and *be fed by* the reward ledger.

- Surface d44/d48/d49 outputs in UI:
  - `d44_predictive_signals` → "Why now" card on Home / Autopilot
  - `contextual_opportunities` → slot into Discover *above* the current AI picks section (replacing hardcoded `aiRecommendations` array)
  - `risk_mitigations` → Health / Autopilot coaching tile
- Add REWARD_TABLE entries (proposal to Track A1 team):
  - `signal_acknowledged: 5` (one per signal)
  - `opportunity_engaged: 10` (one per opportunity)
  - `risk_mitigation_acknowledged: 5` (one per mitigation)
  - `memory_fact_confirmed: 2` (one per fact)
- d48 `contextual_opportunities` carry `attribution_surface='autopilot'` or `'orb'` when surfaced by those channels → converted purchases qualify for 1.25× multiplier in Track A1.
- Outcome reporting (+40 CREDITS per `(product, condition_key)`, per Track A1) is the Brain's learning loop — recommendations improve as users are rewarded for feeding back signal.

**Deliverable:** Brain is no longer a silent backend service — it visibly drives decisions, earns users CREDITS for engagement, and improves marketplace conversion attribution.

---

### WS3 — Autopilot honest copy (SHIPPED on this branch)

- ✅ Changed `+10 VTN` badge → `+10 CREDITS` in `vitana-v1/src/pages/AutopilotDashboard.tsx` (3 occurrences: mobile grouped, mobile fallback, desktop fallback).
- ➡️ REWARD_TABLE request for Track A1 team lives at `docs/token-economy/autopilot-earn-spec.md`.

---

### WS4 — Contribution engine + VTNA eligibility (Aug–Sep 2026)

**Critical path for Oct 2026 launch.**

- New service: `services/gateway/src/services/contribution-engine.ts`.
  - Read-side aggregation over `wallet_transactions`, `product_orders`, `referrals`, `marketplace.outcome.reported` events, `relationship_edges`, and d44/d48 signal engagement.
  - Fraud flags from velocity / duplicate-pattern detection (re-scores last 24h nightly, reduces `verified_points` where needed).
- New table: `vtna_eligibility_snapshots`
  ```sql
  CREATE TABLE vtna_eligibility_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    snapshot_month DATE NOT NULL,
    contribution_units INTEGER NOT NULL,
    weighted_score NUMERIC NOT NULL,
    rank_global INTEGER,
    rank_tenant INTEGER,
    tier TEXT, -- 'bronze'|'silver'|'gold'|'platinum'|'diamond'
    components JSONB NOT NULL, -- breakdown per source (referrals, marketplace, brain, engagement)
    fraud_flags JSONB,
    signature TEXT NOT NULL, -- HMAC over canonical JSON for immutability
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, snapshot_month)
  );
  ```
- Monthly roll-up job. Snapshots are signed and immutable. These are the **legally defensible allocation basis** for Oct launch.
- Soft UI tile in Wallet (not a new route): "Your rank: #47 · Next tier: 12 contribution units away". No point totals shown; no token projection; no promise.
- Public leaderboard page (staff-gated until Sep, then opened): top 1000 ranks visible by display name, with live trajectory.

**Deliverable:** Every user knows their rank, can chase it, and the snapshot stream gives the company a defensible basis for any allocation decision.

---

### WS5 — VTNA launch (Oct 2026)

- Feature flag `VITE_VTNA_ENABLED` flips on.
- `BuyTokensPopup` becomes functional (Stripe rail → VTNA purchase, subject to compliance envelope tracked on `claude/crypto-compliance-docs-b9WMn`).
- `StakeTokensPopup` becomes functional (governance / yield mechanics TBD by finance + legal).
- **One-time allocation event** based on signed `vtna_eligibility_snapshots`:
  - Top-N curve (draft — finalised by finance + legal closer to launch):
    - Rank #1 → 1,000,000 VTNA
    - Rank #10 → 10,000 VTNA
    - Rank #100 → 1,000 VTNA
    - Rank #1000 → 100 VTNA
  - Curve shape, exact numbers, and anti-gaming windows (e.g. snapshots rolling over last 6 months) to be confirmed.
  - Opt-in, disclosed in advance, legally reviewed, KYC-gated.
- **Credits → VTNA conversion rail is explicitly deferred** unless compliance clears.

---

## 5. Phasing

| Phase | Window | Owner | Outputs |
|---|---|---|---|
| P1 | Now → early May | Reward team (Track A1/A2/A3) | Reward expansion ships. Zero-reset. Redemption catalog live. |
| P2 | May → Jun | This branch | WS1 Business HUB wired to marketplace. WS3 autopilot copy (done). |
| P3 | Jun → Aug | This branch + Brain team | WS2 Brain surfaces + reward emitters. Outcome reporting loop active. |
| P4 | Aug → Sep | This branch + Compliance | WS4 contribution engine + eligibility snapshots. Leaderboard. Compliance sign-off. |
| P5 | Oct | Launch team | WS5 VTNA enable + Top-N allocation event. |

---

## 6. Investor surface

A staff-only route renders real metrics from real ledger tables:

- Active businesses (merchants with ≥1 order last 30d)
- GMV / month (sum of `product_orders.amount_cents` by month)
- Transaction velocity (orders per DAU)
- Retention cohorts (D7, D30, D90)
- CREDITS velocity (earned → redeemed round-trip time)
- Top-N contribution distribution (rank histogram)
- Autopilot → marketplace conversion rate
- Referral acquisition funnel

This is the doctrine's "what investors must see" — powered by real data, not mocks.

---

## 7. What this plan will not do

- Show speculative VTNA balances in user-facing UI before launch
- Promise guaranteed CREDITS → VTNA conversion
- Mix rewards and token language ("earn tokens")
- Launch click-based reward emitters (gameable)
- Create parallel ledgers for scoring / contribution (read-side only)
- Delay Business HUB earnings or marketplace monetisation
- Ship Brain engines that produce no user-visible value

---

## 8. One-line strategy

> Build income and community today — reward contribution with ownership tomorrow.
