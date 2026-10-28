# VTID-03767 — Serbian nav i18n misalignment + assistant Maxina/Vitana naming fix

User report, live in the app: (1) with Serbian selected, a News Feed "Did
You Know" card still rendered in English; (2) that same card said "Talk to
Maxina", but the in-app assistant is named **Vitana** — MAXINA is only the
app/brand name; (3) the bottom nav bar's category names don't match the
sidebar/drawer nav's category names for the same destination (worst case:
Serbian's Inbox route had three different words across the three nav
surfaces). Asked to check whether the same class of bug exists for other
languages too.

This VTID covers the **gateway (backend content)** half of the fix; the
companion **vitana-v1** half (nav label alignment across locales, and the
frontend locale-fallback chain) is `exafyltd/vitana-v1#1044`, same branch.

---

AC-1 — The assistant is called Vitana, not Maxina, everywhere this repo speaks for it

TEST: manual grep verification (see `commands.log`) — `grep -n
"Maxina\|ماكسينا\|Максин" services/gateway/src/data/feature-tips.ts
services/gateway/src/services/recommendation-engine/analyzers/community-user-analyzer.ts`
returns only the two explanatory code comments, zero live string content.
Output: `outputs/maxina-grep.txt`

Fixed in two content pools:
- `data/feature-tips.ts` — the `assistant-voice` daily-tip entry
  ("Talk to Maxina" / "You can talk to Maxina with your voice...", en+de).
- `recommendation-engine/analyzers/community-user-analyzer.ts` — 4
  recommendation-card blocks (`onboarding_maxina`, `onboarding_diary`,
  `set_goal`, `mood_support`) × 8 languages (en, de, fr, es, ar, zh, ru, sr)
  = 31 string occurrences, all replaced.

The internal `onboarding_maxina` object **key** is deliberately left
unchanged — it's a stored recommendation-type identifier read by 6 other
files (`wave-defaults.ts`, `ranking/index-pillar-weighter.ts`,
`analyzers/index-gap-analyzer.ts`, `journey-calendar-mapper.ts`,
`routes/autopilot-recommendations.ts`), not user-visible text. Renaming it
would be a separate, larger, riskier change (a live-data key rename) that
this VTID's scope doesn't need.

AC-2 — No language regresses to English for the daily-feature-tip content

TEST: manual review — `FeatureTip`'s `title`/`description` type widened
from `{ en: string; de: string }` to `{ en, de } &
Partial<Record<Exclude<GatewayLocale,'en'|'de'>, string>>`; all 12
`FEATURE_TIPS` entries now carry es/sr/fr/pt/ru/pl/zh/ar in addition to
en/de, matching `GATEWAY_LOCALES`. Key count unchanged (12 before, 12
after) — confirmed via `python3 -c "import re; ..."` in `commands.log`.
Output: `outputs/tip-keys.txt`

Root cause (confirmed, not assumed): `useAllNewsFeed.ts` (companion
vitana-v1 repo) resolves this content via `row.feature_title[language] ??
row.feature_title.en` — any locale other than en/de fell straight to
English with no error surfaced anywhere. That fallback itself is also
hardened in the companion PR (`locale → en → de`, matching this repo's own
`pickLocale()` convention in `admin-feature-announcements.ts`), but the
root fix is here: give every locale real content so the fallback is rarely
exercised in the first place.

AC-3 — No regression to the touched files' TypeScript correctness

TEST: `npx tsc --noEmit -p tsconfig.json` (services/gateway)
Output: `outputs/tsc.txt`
Result: only the pre-existing, repo-wide `moduleResolution=node10`
deprecation notice (present on `main` regardless of this change) — zero
errors attributable to either touched file.

AC-4 — The live production seed (not just the TS content) says Vitana too

TEST: `services/gateway/test/autopilot-onboarding-seed-bundle.test.ts`, all
cases — this test parses `supabase/migrations/*_seed_community_onboarding_autopilot.sql`
and asserts every day0 row matches `STAGE_TEMPLATES.day0` in
`community-user-analyzer.ts` field-for-field. It caught a THIRD copy of this
same bug this VTID's first commit missed: `seed_community_onboarding_autopilot()`
— a Postgres function fired by an `AFTER INSERT` trigger on
`public.user_tenants` for every new community member — hardcoded
`'Say hello to Maxina'` / `'Your AI companion Maxina is ready to get to know
you...'` directly into its `INSERT ... VALUES` bundle. Unlike the other two
fixes in this VTID, this one was live and ongoing: every new signup got the
wrong name inserted into their own onboarding Autopilot recommendations.
Output: `outputs/seed-migration-parse.txt`, `outputs/seed-migration-diff.txt`

Fixed via a NEW migration
(`20260827090000_vtid_03767_fix_seed_community_onboarding_autopilot.sql`)
that does `CREATE OR REPLACE FUNCTION public.seed_community_onboarding_autopilot`
with the corrected two text values — never editing the original, already-applied
migration file in place. Every other field of every other row is byte-for-byte
unchanged (see `outputs/seed-migration-diff.txt` — a single-line diff).

The test's own `loadSeedMigration()` helper only ever looked at ONE file
matching `*_seed_community_onboarding_autopilot.sql` via raw `readdirSync`
order — not safe once a second, superseding migration exists. Fixed to sort
matching filenames and read the chronologically LATEST one (the timestamp
prefix is exactly the property Supabase orders migration application by),
so this is now safe for future follow-up migrations too, not just this one.

AC-5 — File-format hygiene: no incidental diff noise

TEST: manual `file <path>` + `git diff --stat` check (see `commands.log`)
Output: `outputs/tsc.txt` (diff stat), verified inline
Result: `community-user-analyzer.ts` kept its original CRLF line endings —
a first pass via a Python script without `newline=''` silently normalized
the whole file to LF, which would have produced a ~1900-line diff for a
31-string change; caught before commit, reverted, and redone. Final diff:
`feature-tips.ts` +284/-9 (net content addition, expected for 8 new
locales × 12 tips), `community-user-analyzer.ts` +32/-32 (line-for-line
string replacement, no line-ending drift).

---

## Verification summary

| Check | Result |
|---|---|
| `tsc --noEmit` (services/gateway) | clean (only pre-existing tsconfig warning) |
| Stray "Maxina" in touched files | 0 (outside explanatory comments) |
| `FEATURE_TIPS` key count | 12 → 12 (unchanged) |
| CRLF preserved on `community-user-analyzer.ts` | confirmed |
| `autopilot-onboarding-seed-bundle.test.ts` | caught the seed-migration copy of this bug (real CI run, see AC-4); fixed |
| Other existing test coverage referencing these files | 4 more test files checked; none pin the changed string literals, none require updating |

**Correction, made honest rather than silently fixed:** the first commit on
this VTID claimed "no test pins the specific Maxina strings that were
changed" — true for `feature-tips.ts` and the 4 direct callers of
`community-user-analyzer.ts`, but wrong for the seed migration's copy of the
same content: `autopilot-onboarding-seed-bundle.test.ts` DOES pin it, by
parity rather than by literal string match, and it failed on the very first
real CI run of this PR (`services/gateway/test/autopilot-onboarding-seed-bundle.test.ts`
— "day0 template onboarding_maxina matches the seeded row field-for-field",
`Expected: "Say hello to Vitana"`, `Received: "Say hello to Maxina"`). That
failure is what surfaced AC-4 above; this sandbox's static-only verification
(no `node_modules`, no live DB) could not have caught it on its own.

## What this VTID does NOT cover, and why

- **The Jest test suite could not be run in this sandbox** — no
  `node_modules`, no npm registry access (`npm ci` returns 403 from the
  outbound proxy for any package not already cached). `tsc --noEmit` plus
  manual grep verification is the strongest static check available here.
  The repo's own CI (`Gateway (Jest, ~7.5k tests)` / `Gateway Service
  Tests` jobs) is expected to run the full suite for real on this PR.
- **No live/staging confirmation that a Serbian session now sees the
  translated tip.** This session has no means to trigger a real
  `daily-feature-tip` cron run or inspect a live `feature_announcements`
  row, and per `vitana-v1`'s CLAUDE.md absolute rule, writing test rows to
  the production Supabase project to manufacture that confirmation is not
  permitted. Verified at the content-source level instead: the exact
  object every locale reads from now has real, non-English content for
  that locale.
- **Translation quality is a good-faith direct translation**, not run
  through this repo's `i18n-audit-llm.yml` LLM audit workflow (that
  pipeline is for the companion vitana-v1 repo's `src/i18n/**` shards, not
  this gateway-side content pool) — flagging as a reasonable follow-up if
  the team wants a second pass, not a blocker.

## OASIS impact

None. This VTID does not add, remove, or change any `oasis_events` emit
site, event type, or route — content-only change to a data file consumed
by an existing, unmodified cron route (`POST
/api/v1/scheduled-notifications/daily-feature-tip`) and an existing,
unmodified admin content pool consumed by
`recommendation-engine/analyzers/community-user-analyzer.ts`'s existing
callers.
