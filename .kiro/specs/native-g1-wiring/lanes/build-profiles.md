---
lane: build-profiles
state: ready
next_actor: kiro
depends_on: [vitana-v1-verified, env-profiles]
executor: claude
area: frontend
reviewer_seat: claude
paths:
  - apps/mobile/eas.json
  - .github/workflows/NATIVE-CI.yml
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-10-20T08:41Z
vtid: VTID-05247
---
# EAS/local build profiles + offline per-profile CI bundle (decision 2) — GOVERNANCE PATH
Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: build-profiles -->` (tasks B1–B3) are authoritative. VTID: assigned by CI after PLAN-SPAR
converges; do not start before `vtid:` is set here.
**Executor claude (collaboration §3a):** this lane edits a governance path (`.github/workflows/NATIVE-CI.yml`)
and is therefore built and reviewed by Claude Code, never a Kiro seat. Kept alone so no other lane touches
`.github/**` (every other lane's `paths` are under `apps/mobile/**` or `docs/validation/**`).
**Goal.** `apps/mobile/eas.json` defines `development` + `test-g1` profiles (set `APP_PROFILE`, map the
`EXPO_PUBLIC_*` inputs to the `env-profiles` source; no `production` profile — mirrors `app.config.ts:36`).
NATIVE-CI gains an offline (`EXPO_OFFLINE=1`), secret-free step that bundles both profiles and asserts the
`test-g1` bundle has no production/staging host string (probe idea: `apps/mobile/probe/check-probe.js`).
No Expo token, store credential, Firebase/`google-services` file or signing (G2/G3 — `apps/mobile/README.md`
"What waits for which gate"); no EAS cloud build.
**Acceptance (reviewer = claude):**
- `eas.json` has exactly `development` + `test-g1`, no `production`, no credential field.
- NATIVE-CI bundles both profiles offline and green; the host-string assertion passes; no secret/token
  added; not made a required check.
- **Lane scope** green (only `.github/workflows/NATIVE-CI.yml` + `apps/mobile/eas.json` + the validation docs).
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only), `plan-sparring.md`.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no
writes to Supabase/AWS, no test against production; the profiles never point a build at a real host.
## Log
### 2026-10-17T10:56Z · <kiro-session-id> · created → ready
Lane drafted with the plan. Marked `executor: claude` / `reviewer_seat: claude` because it is the only lane
that edits `.github/**`. Depends on `env-profiles` (it feeds that env source into the bundle). Next:
PLAN-SPAR spars the plan; once a VTID is written here, Claude Code picks it up (exceptions / governance
lanes, collaboration §7).

### 2026-10-20T08:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05247 allocated after policy approval (converged-auto-v1).
