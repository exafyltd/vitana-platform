# Vitana Business Model

> Canonical quantified spec for the billing v1 launch. Engineering reads this; customer-facing copy lives in the i18n shards and KB chapters (cross-referenced below). All numbers in this document are config — single SQL UPDATE retunes any value without a deploy.
>
> **VTID:** VTID-03107
> **Status:** Spec for launch (v1). Numbers tuneable post-launch via DB config; mechanism changes require new VTID.
> **Last updated:** 2026-05-26 (rolling-window Free quotas + auto-grant for existing users)

---

## 1. The four privacy + trust promises (lead with these)

Anchored on the Subscriptions screen, the Trust Center, and every Premium upsell. These are the brand promises — every screen, every email, every push notification stays compatible with them.

1. **You own what you share.** Memory, profile, recommendations — all visible, exportable, deletable.
2. **We never sell your data to advertisers, brokers, or partners.** Enforced in code (D36 + monetization-attempts ledger).
3. **Your experience, expertise, and recommendations can earn for you.** When your recommendation closes a sale through Sell and Earn or when you host a paid Live Room, you get the income — transparently disclosed.
4. **You decide what Sell and Earn does for you.** Three switches plus per-channel autonomy plus per-category exclusions, visible in the Connect screen.

**Things never said in customer copy** (enforced by the forbidden-strings i18n test in PR-3):
- "Your data is your asset" / "monetize your data" / "data licensing" — too close to a regulatory product we don't ship in v1
- "Premium 5×" / "Premium 20×" / "PAYG" / "VAEA" / "managed AI" / "BYO" — engineering terms
- "Unlimited" for any variable-cost feature — use "generous fair use" or an explicit number
- "Quota" / "throttle" / "burn" / "consume" — internal jargon
- "Tier" — use "plan"

---

## 2. Plans (4 tiers + 6 price variants + 3 credit packs)

### Internal naming vs customer-facing

| Internal `plan_key` | Customer-facing label (i18n) | Quota multiplier vs Premium |
|---|---|---|
| `free` | **Free** | — |
| `premium` | **Premium** | 1× |
| `premium_5x` | **Host** | 5× |
| `premium_20x` | **Community** | 20× |

Internal keys carry the multiplier semantics for reasoning + telemetry. Customer-facing names lead with outcomes ("Host" = "you can host bigger rooms" / "Community" = "you can run a community").

### Pricing

| Plan | Monthly | Annual | Best for |
|---|---|---|---|
| **Free** | €0 | — | Trying out, casual use |
| **Premium** | **€9.99/mo** | **€89/yr** (save ~26%) | Daily wellness use |
| **Host** | **€99/mo** | **€890/yr** (save ~25%) | Power user, family, regular host |
| **Community** | **€199/mo** | **€1990/yr** (save ~17%) | Coach, practitioner, community lead |

All paid tiers include a **14-day free trial** on first subscription (Duolingo-equivalent). Trial converts to paid automatically unless cancelled.

EUR-only at launch. EU VAT handled by Stripe Tax. USD/global price lists post-launch via additional `subscription_plan_prices` rows.

### Customer-facing presentation

The Subscriptions screen leads with **Free vs Premium** as the binary headline choice. Host and Community are surfaced behind a **"Need more live time or hosting?"** disclosure for power users only. The "Add extra minutes" tile (credit packs) sits **outside** the plan grid as an action, not a fourth tier.

### Credit packs (one-shot purchases — works on any plan)

| Internal SKU | Customer label (i18n) | Price | Credits | Bonus |
|---|---|---|---|---|
| `starter` | "10 hours of standard voice OR 100 live minutes" | €4.99 | 500 | — |
| `boost` | "Most popular — 7 hours of live voice" | €19.99 | 2,200 | +10% bonus |
| `power` | "Heavy use — 40 hours of live voice" | €99 | 12,000 | +20% bonus |

**1 credit = €0.01** baseline. Bonus credits are volume incentive — they live in the same `purchased_credits` bucket and have the same purchasing power.

---

## 3. The most-valued features (paywall surface)

Six metered features. v1 enforces **hard cuts on all six** on Free. Existing onboarded users are protected from those walls by the launch auto-grant (§9). Paid plans see only the monthly cap. Free sees three rolling windows so the user always has a near-term recovery option (Claude / ChatGPT pattern).

### Free tier — three rolling windows

The Free user gets two short-window caps (5h + weekly) AND a monthly soft ceiling. **The weekly cap is almost always the binding limit.** The 5h cap stops burst use and refreshes ~4×/day. The monthly is set above weekly×4.3 so it acts as a safety ceiling, not the day-to-day pain point.

| # | Feature | 5h window | Weekly cap | Monthly ceiling | Enforcement |
|---|---|---|---|---|---|
| 1 | **Live AI voice** (Gemini Live) | 5 min | 20 min/wk | 80 min/mo | Hard: degrade to standard voice OR PAYG |
| 2 | **Live Rooms hosting** (Daily.co) | 20 min | 60 min/wk | 240 min/mo | Hard: graceful end OR PAYG |
| 3 | **Find-a-Match posts** | 2 | 5/wk | 20/mo | Hard: 402 OR PAYG |
| 4 | **Find-a-Match reveals** | 3 | 10/wk | 40/mo | Hard: 402 OR PAYG |
| 5 | **Lab analysis** (OCR + LLM) | 1 | 3/wk | 12/mo | Hard: 402 OR PAYG |
| 6 | **Photo uploads** | 5 | 15/wk | 60/mo | Hard: 402 OR PAYG |

When the user hits ANY of the three caps, the in-context message shows the sooner reset (always the 5h window during active use, the weekly cap otherwise). The Usage drawer shows both bars side-by-side.

### Paid tiers — monthly only

| # | Feature | Premium | Host | Community | PAYG rate |
|---|---|---|---|---|---|
| 1 | Live AI voice | 30 min/mo | 150 min/mo (5×) | 600 min/mo (20×) | 5 credits/min |
| 2 | Live Rooms hosting | 5 hrs/mo | 25 hrs/mo (5×) | 100 hrs/mo (20×) | 1 credit/min |
| 3 | Find-a-Match posts | 20/mo | 100/mo | 400/mo | 50 credits/post |
| 4 | Find-a-Match reveals | 50/mo | 250/mo | 1,000/mo | 10 credits/reveal |
| 5 | Lab analysis | 5/mo | 25/mo | 100/mo | 50 credits/lab |
| 6 | Photo uploads | 50/mo | 250/mo | 1,000/mo | 1 credit/photo |

Paid plans have `window_5h_quota` and `weekly_quota` NULL — only the monthly cap is checked. PAYG credits work across all plans for overage.

### Storage included in every plan

| Plan | Vitana Storage |
|---|---|
| Free | 100 MB |
| Premium | 5 GB |
| Host | 25 GB |
| Community | 100 GB |
| Overage | 50 credits = 1 GB / month (PAYG) |

Metering scope: upload size (storage_objects trigger) + transformed-image bandwidth + daily egress check.

### Other features (free for everyone, no metering)

Calendar, Knowledge Hub, basic diary, group memberships, wellness lists, direct messages — all free at launch, same on every plan. Premium plans get **feature-flag perks** with no per-action metering:
- `auto_schedule_calendar` (Premium+)
- `premium_priority_practitioner` (Premium+)
- `ai_digest_cadence: daily` (Premium+) vs `weekly` (Free)

### Live Rooms participant guardrail (internal)

Customer copy: "fair-use participant limits apply."
Internal cap: 60,000 participant-minutes/month per host on Community plan (100h × avg 10 ppl). Beyond → contact for custom tier. Bounds Daily.co cost at the most expensive plan's worst case.

---

## 4. Wallet — three buckets, one ledger

The single most important cashflow guardrail in v1: **separation by source AND by burn path**.

| Bucket | Source | Burn paths in v1 |
|---|---|---|
| `purchased_credits` | Stripe credit-pack top-ups · ENTER-code grants · refunds · transfers | **Any feature** (default) — Live AI overage, Room overage, lab, photo, match |
| `reward_credits` | Diary streaks · milestones · referrals · hosted workshops · wellness-list rewards · group-creation rewards | **Cheap features only** — match reveal · photo · lab. **NEVER** Live AI minutes, Room minutes, or subscription discount. |
| `cash_balance` | Sell-and-Earn commissions held by Vitana · Stripe Connect hosting payouts · workshop revenue | **Withdrawable to bank** via Stripe Connect Express. Not in-app spend. |

Implementation: 3 columns on `wallet_balances`. The legacy `balance` column stays as the sum across buckets for backward compatibility.

**Rules** (enforced by `feature_entitlements.allowed_burn_buckets`):
- `consumeCredits(userId, feature, amount)` checks the feature's `allowed_burn_buckets` config
- Burn order when both allowed: **rewards first** (drain the lower-utility bucket first; preserves cash-equivalent purchased credits)
- UI: Wallet page shows up to three rows (Credits / Rewards / Cash earnings). Subscriptions/checkout flows show only `Credits`.

---

## 5. Sell and Earn — recommendation income, with flat platform rules

The customer-facing name for the VAEA service. Phase 0+1.5 already shipped (observe-mode, shadow drafts, no posting). v1 commercial framing locks the platform's revenue rules:

### Two flat commission rules (NOT tier-scaled)

| Income type | User keeps | Vitana keeps | Already wired? |
|---|---|---|---|
| **Vitana-processed sale** (Live Room ticket · workshop · service via Stripe Connect) | **90%** | 10% | YES — VTID-01231 Stripe Connect Express |
| **External affiliate** (catalog tier = `affiliate_network`) | **What the network pays** (typically 3–10%) | **0%** (we don't intermediate the cash) | YES — vaea_referral_catalog.affiliate_url |

**Why flat:** tier-scaled splits require commission-attribution + payout-routing code we haven't built. Flat rules align with what's actually live. Tier rises buy *capability* (more catalog items, more channels, higher autonomy), not a better payout percentage.

### Sell-and-Earn capability ladder per plan

| | Free | Premium | Host | Community |
|---|---|---|---|---|
| Catalog size | 5 items | 25 items | 100 items | 1,000 items |
| Daily draft limit | 1 | 5 | 25 | 200 |
| Channels listened | 1 (community) | 3 | 10 | 50 |
| Autonomy ceiling | `draft_to_user` | `draft_to_user` | `one_tap_approve` | `one_tap_approve` |
| Voice/persona cloning | Off | Off | Off | Off *(deferred from v1 launch)* |
| Detected-questions visibility | Last 7 days | Last 30 days | Last 90 days | Lifetime |

`auto_post` autonomy is feature-flagged off platform-wide in v1.

### "Your Earnings" widget (Subscriptions screen)

Honest, read-only. Only renders for users with non-zero `cash_balance` history. For Free / new users: hidden — **no projected-earnings copy, no "Premium users typically earn…" claims**.

```
YOUR EARNINGS (this year)
  Live Room hosting payouts:    €280.50
  Sell and Earn commissions:     €54.00
  ────────────────────────────────
  Total in your wallet:         €334.50
                                          [Withdraw]
```

---

## 6. Trial structure + launch giveaway campaigns

Four layered paths to free Premium access, each with its own cap and cashflow ceiling:

| Path | Who gets it | Length | Mechanism | Launch state |
|---|---|---|---|---|
| **Standard trial** | Every new Premium signup | 14 days | Stripe Checkout `subscription_data.trial_period_days: 14` | ACTIVE |
| **Test cohort codes** ("ENTER codes") | First 100 inner-circle users (admin-issued) | **12 months** | 100 unique codes (`VITANA-TEST-A4F2-9KX1`), `max_uses=1` each, generated via Command Hub admin section in PR-5 | ACTIVE (PR-5 generates) |
| **Founding Member promo** | First 500 public signups via marketing code | **3 months** | One shared `FOUNDING` code, `max_uses=500`, `is_active=true` | ACTIVE (seeded migration 6) |
| **Referral bonus** | New user via someone's referral link | 30 days for the new user (one-sided) | `referral_redemptions` audit, max 5,000 grants total | **PAUSED** at launch (`is_active=false`); flipped on after PR-6 telemetry confirms safe |

### Launch-day cashflow ceiling

| Campaign | Users | Duration | Infrastructure cost worst-case | Foregone revenue |
|---|---|---|---|---|
| Test cohort | 100 | 12 months | ~€11,000 | ~€12,000 |
| Founding 500 | 500 | 3 months | ~€16,500 | ~€15,000 |
| Referral 5,000 | 5,000 | 1 month | ~€55,000 | ~€50,000 (PAUSED) |
| 14-day trials | scales | 14 days | ~€5/user | proportional |

**Launch-day combined ceiling (with referral paused): ~€27.5k foregone revenue + ~€27.5k infrastructure = ≤€55k total commitment worst-case.**

### Hard money cap at redemption time

Beyond per-code `max_uses`, `fn_redeem_code` checks AND decrements `tenant_settings.feature_flags.marketing_budget_eur_remaining_cents` BEFORE granting. Counter decrements by `grant_duration_days × monthly_subscription_cents / 30` per grant. When the counter hits zero, redemptions return `BUDGET_EXHAUSTED` until ops tops it up. Real money cap, independent of code-count caps.

Ops seeds the launch-day budget at €55k. Daily OASIS alert if budget drops more than 10% in 24h.

### Lifecycle messaging (Duolingo loss-aversion adapted)

Via existing `notification-service.ts`:

| Day | Trigger | Message |
|---|---|---|
| Day 0 | Trial start | Welcome + 3 personalized starter tiles |
| Day 7 | Trial midpoint | Usage stats so far + "Keep going at €9.99/mo" |
| Day 12 | Trial end-2 | "Your trial ends in 2 days. Want to keep [top-used feature]?" |
| Day 13 | Trial end-1 | "Tomorrow your trial ends. Add a payment method or stay on Free." |
| Day 14 | Trial expires | Silent — Stripe converts or user has cancelled |
| Day 15 (if cancelled) | Post-cancel | "Your memory garden and streak stay. Come back anytime." |
| Day 30 (if cancelled, no return) | Win-back one-shot | Personalized network nudge + 7-day free grant if click-through |

Founding Member uses the same template at 90 / 80 / 88 / 89.

---

## 7. Trust Center — honest privacy transparency

New surface at `/settings/trust-center` (PR-3). Three explicit zones:

```
📱 ON YOUR DEVICE
   Biometric key                 Stays here, never sent
   PIN                           Stays here, never sent
   Photo originals (cache)       Cleared after 30 days
   Draft text                    Stays here until you save

🏠 ON VITANA SERVERS (EU region, encrypted at rest)
   Health profile, Memory Garden, Sell-and-Earn catalog, Wallet ledger
   Voice transcripts only when you opt in

🌐 SENT TO YOUR AI PROVIDER (Vitana-managed Gemini)
   Each chat turn: your message + tool results
   Voice audio: streams during live calls, not retained
   Your profile: never sent directly, summarized on our side first

   [View AI call history] · [Export everything] · [Delete my account]
```

### Honesty hard gate (PR-3 acceptance criterion)

Today `ai_usage_log` is only written by the ORB delegation path — not every AI surface. PR-3 cannot ship the Trust Center page in its full form until this is resolved. Two acceptance modes — PR-3 must pick one:

- **Mode A — Full wiring**: instrument every AI provider call site (LLM, TTS, STT, embeddings, image-gen) to write to `ai_usage_log`. Then the panel can claim "all AI activity is visible here."
- **Mode B — Narrowed honest panel**: ship the page with a tighter copy: "Showing N of M tracked AI surfaces. Other providers (TTS, embeddings, …) are not yet audited." List which surfaces ARE in the log, with last-call timestamp.

No fake transparency under any circumstances. If neither mode is achievable, the link is hidden from Settings and the page does not ship in v1.

---

## 8. Cashflow Guardrails (canonical — every PR must honor these)

1. **No "unlimited" anywhere** in copy or schema. Every metered feature has a monthly quota, even on the €199 tier. Marketing language: "generous fair use" or explicit numbers.
2. **Three separate financial paths, never mixed in v1**: subscriptions fund tier access · purchased credits fund overage · earned rewards drive retention.
3. **Voice and Live Room overage is paid only by purchased credits or hard-degrade.** Never by reward credits, never by extending the monthly tier quota.
4. **Two-column wallet** enforces #3 at the schema level — `feature_entitlements.allowed_burn_buckets` config determines which buckets can pay; `fn_consume_credits` checks before debit.
5. **D36 vulnerability deferral** → degrade to standard voice / offer PAYG credits / wait, but **never gift expensive minutes**. Deferral itself is metered: max 3 defer-grants per user per month (configurable).
6. **All discount/multiplier mechanisms are out of launch scope** — no code, no flag, no promise. Specifically: 2× earn multiplier, subscription offset, Earn-Your-Month milestone, reward→subscription conversion are NOT in v1.
7. **All caps are config**, not code — `subscription_plans.features_json`, `feature_entitlements.quota`, `redemption_codes.max_uses`, `tenant_settings.feature_flags.marketing_budget_eur_remaining_cents`. Single SQL UPDATE retunes any value.
8. **Credit reservation pattern**: any future "credits at checkout" flow must reserve credits BEFORE Stripe checkout and release on Stripe failure (prevents double-spend race). Not in v1 scope.
9. **Marketing-budget cap is a hard money guard**: `fn_redeem_code` and `fn_grant_referral` decrement the cap at redemption time and return `BUDGET_EXHAUSTED` when zero.
10. **Feature flags can instantly reopen any gate** — `tenant_settings.feature_flags.billing_v1_*` rows control every paywall surface; tier quotas live in DB, never in TypeScript constants.

---

## 9. Launch auto-grant for existing onboarded users

Locked decision (2026-05-26): every user who was onboarded BEFORE the billing v1 deploy automatically receives a **12-month Premium subscription** — no codes, no clicks, no email. The grant runs once during deploy via migration `20260526110000_VTID_03107_launch_auto_grant.sql`.

**What it does:**
- Iterates every `user_tenants.is_primary = true` membership where `app_users.created_at < now() - 24h`
- Skips any user with an active/trialing/past_due subscription (auto-grant is a floor, not an override)
- Writes a `user_subscriptions` row: `plan_key='premium'`, `status='active'`, `current_period_end=now()+365d`, `price_key=NULL` (no Stripe binding)
- Tags with `metadata.source='launch_auto_grant_2026'`, `metadata.no_friction=true`, `metadata.granted_at`, `metadata.grant_duration_days=365`

**What the user sees** on next app open (no push, no email):
- Settings → Subscription shows their plan as **Premium** with subtitle "auto-granted at launch · ends YYYY-MM-DD"
- A one-time welcome banner above the plan card: "🎁 Welcome from us — you've received 12 months of Vitana Premium on us. Active until {date}. No action needed. Enjoy."
- Banner is dismissible (`localStorage` keyed by user id). The plan-card subtitle stays so the user can always check the source.

**End of grant (day 350):**
- One pre-end nudge: "Your Vitana Premium grant ends in 15 days. Continue for €9.99/mo or stay on the Free plan." (push + in-app banner, no email)
- At day 365: cron flips status to `canceled` and plan back to `free`. Same UX as any expired paid sub.

**Cashflow note:** foregone-revenue worst case ≈ user_count × €9.99 × 12 months. At ~2,000 users that's ~€240k foregone. Real cash spent is bounded by Premium quotas (30 min voice + 5h rooms + small features per month) ≈ €10/user/mo ≈ ~€240k infra worst case. Acceptable: existing users are the highest-value cohort we have, and the alternative — telling onboarded users to "redeem a code" — is poor UX.

This grant supersedes the test-cohort codes for already-onboarded users. The test-cohort + Founding code campaigns (§6) remain active for NEW signups who arrive after the deploy.

---

## 10. Not in launch scope (intentional — not promised anywhere)

- ❌ Match-reveal / Match-post / Memory / Autopilot active 402 paywalls (soft UI badges only in v1)
- ❌ Family plan / multi-seat subscription
- ❌ Education / NGO discount portal
- ❌ Annual gift card flow
- ❌ Streak-save trial-extension flow
- ❌ Per-conversation AI audit detail screen
- ❌ Voice-transcript opt-in UI controls
- ❌ Tier-scaled Sell-and-Earn commission percentages (flat rules only)
- ❌ "100% to user on own products" promise (contradicts existing 90/10 Stripe Connect)
- ❌ Data licensing / anonymized data marketplace
- ❌ Sell-and-Earn auto-posting / mesh broker / voice cloning
- ❌ BYO AI key (OpenAI/Anthropic/Gemini) credit-back
- ❌ BYO cloud Drive (Google/iCloud/Dropbox/OneDrive) credit-back
- ❌ 2× Premium earn multiplier
- ❌ 50% subscription offset at checkout
- ❌ "Earn Your Month" 5,000-credit milestone
- ❌ Bilateral referral bonus (both sides get free time)

Each of these is a separate scoped project with its own cashflow analysis when proposed. Nothing here is committed in this plan.

---

## 11. Cross-references

| Customer-facing copy | Engineering implementation |
|---|---|
| KB chapter [`docs/knowledge-base/en/18-wallet/04-subscriptions.md`](../knowledge-base/en/18-wallet/04-subscriptions.md) | This file + i18n shards in `vitana-v1/src/i18n/de/subscriptions.json` (PR-3) |
| KB chapter [`docs/knowledge-base/en/06-financial-longevity/03-credits-cash-and-vtn.md`](../knowledge-base/en/06-financial-longevity/03-credits-cash-and-vtn.md) | §4 (wallet buckets) above |
| KB chapter [`docs/knowledge-base/en/07-maxina-experience/03-ethical-ai-and-privacy.md`](../knowledge-base/en/07-maxina-experience/03-ethical-ai-and-privacy.md) | §7 (Trust Center) above |

Plan source of truth: `.claude/plans/the-plan-should-also-humming-stonebraker.md` (engineering plan, with full §A–§T sections).
