# Session Handoff — "D · Vitanaland Commerce" workspace

**Purpose:** carry the working context of the Vitanaland Commerce session into a
fresh Claude Code session. The old session accumulated orphaned `send_later`
self-check-in tasks (for the long-merged PR #2585) that ran the account into its
weekly usage limit and caused persistent "Too many requests" (429) errors. It is
being retired. **This document is the narrative memory; git history + the two
`CLAUDE.md` files are the rest.**

> How to use in the new session: say *"read SESSION-HANDOFF.md"* (and its
> `vitana-v1` twin if present). Then re-verify live PR/CI state via the GitHub
> tools — the statuses below are last-observed snapshots, not live truth.

---

## How "memory" actually carries over

| Layer | Carries over automatically? | Where it lives |
|-------|------------------------------|----------------|
| Code, commits, branches, PRs | ✅ yes | git (cloned fresh each session) |
| Project conventions/architecture | ✅ yes | `vitana-platform/CLAUDE.md`, `vitana-v1/CLAUDE.md` (auto-loaded) |
| This conversation / decisions / in-flight thread | ❌ no | **this file** |

Nothing in the actual work was lost when the old session broke — it was a
session-runtime problem, not a code problem.

---

## Active branch

Both repos are on **`claude/session-troubleshooting-taahrx`**.

- `vitana-platform` HEAD: `3592dba Fix ORB language flip on guided-session narration (#2817)`
- `vitana-v1` HEAD: `c9b8381 fix(liverooms): surface the real Go-Live failure reason… (#827)`

---

## The central thread: VCAOP (Vitanaland Commerce & Account-Operations Platform)

This workspace's main initiative. Backend lives in `services/vcaop/`.

- **PR #2585 — MERGED 2026-06-08.** "VCAOP: full backend build (CTRL→CICD),
  dev-only, mock-first — 159 tests, both DoD e2e flows." Branch
  `claude/vibrant-lovelace-DBM5k`. The foundation: CTRL guardrails, IAM/RLS,
  VAULT (TOTP), CONN connectors, KYB, AGNT, RWD attribution+wallet, CMRC cart,
  OBS, CICD. UIC/UIA view-models built but React wiring blocked (BLK-003).
  Known runtime human-task blockers: dev Supabase/Cloud Run (BLK-001), real
  provider SDKs+credentials (BLK-002), frontend wiring (BLK-003).
- **PR #2603 — OPEN (marked ready, not draft).** "VCAOP Phase 3: affiliate
  aggregator client scaffold (mock-to-real)." Branch `claude/vibrant-lovelace-DBM5k`.
- **PR #2786 — OPEN (draft, CI was running, +888).** "feat(vcaop): Admitad
  product catalog sync (Products API → /d…)." Branch `claude/admitad-product-catalog`.
- **PR #2784 — OPEN (draft).** "feat(vcaop): Awin product feed discovery +
  one-step activation." Branch `claude/awin-feed-discovery`.
- **PR #2691 — MERGED.** `claude/shopify-catalog-sync` (Shopify catalog sync).

**Likely next step for commerce work:** verify CI on #2786 / #2784, then move the
aggregator integrations from mock toward real provider SDKs/credentials (BLK-002).

---

## Other open work in flight (vitana-platform)

Grouped; all drafts unless noted. Re-verify CI/state before acting.

**ORB (voice/agent) — large active cluster:**
- #2760 remove hard-coded vague ORB greeting
- #2754 route by-name profile views to community member lookup
- #2759 never dead-end "improve my Index" (graceful degrade)
- #2808 Vitana DM follow-ups lose context / mis-route reminders
- #2805 regression harness for trust-critical action tools
- #2719 refresh stale `buildLiveSystemInstruction` snapshots
- #2761 fix CI orb-tools parity gate reading 0 tools

**Platform / navigator / other:**
- #2812 group chat message edit/delete endpoints (VTID-03089)
- #2806 make `allocate_global_vtid` tolerate sequence drift
- #2747 show frontend (community-app) staging build in PUBLISH panel
- #2718 persist guided-journey listened-session progress server-side
- #2783 expand German longevity news sources + drop dead feeds
- #2781 repair feedback classifier cron broken by two-gate RPC
- #2779 docs: VITANA desktop platform navigation/routing inventory
- #2720 navigator role-scoping foundation (persist allowed_roles)
- #2697 route "community board" to the full board view (mobile nav)
- #2702 fix account deletion regression (wallet FK blocks auth.users)

**vitana-v1 (frontend) recent merges on this branch:**
- #827 surface real Go-Live failure reason (live rooms)
- #826 restore persisted queries with original timestamp (live rooms cache)
- #825 fix live-room share link 404

---

## Open operational issue to be aware of

The retired session left **5 stuck "Running" background tasks** ("Self check-in …
PR #2585", 500–590h cumulative) that the UI `□` button would not clear and that
have no live process (they're orphaned server-side `send_later` schedules). They
were burning weekly quota. **Action taken:** unsubscribed PR #2585 webhook
activity. **Still to do (human):** fully end/close the old session so its
schedules tear down; the account's weekly usage limit resets (banner said
~1:00 PM) or can be upgraded. Do **not** re-arm long-lived PR self-check-ins on
already-merged PRs.

---

## Key conventions reminder (full detail in CLAUDE.md)

- **Staging-first cutover** is in effect (since 2026-06-08): push to `main`
  auto-deploys **staging only**; production is reached via the **PUBLISH** button
  in Command Hub or the `scripts/deploy/publish-to-prod.sh` escape hatch.
- **i18n hard rule:** no hardcoded user-visible strings; DE is source of truth,
  du-form. Gateway user-facing strings go through the `tt()` catalog.
- **AI/LLM calls** must inject the user's locale (`llm-locale` helpers).
- **GCP:** project `lovable-vitana-vers1`, region `us-central1`, health `/alive`,
  port `8080`. Verify deploys per CLAUDE.md §15.
