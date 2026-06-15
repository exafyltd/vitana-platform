# ORB Fast-Start — Grounded Design & Phase Plan

**Status:** Phase 0/1 (foundation + parity-prep)
**Date:** 2026-06-15
**Owner branch:** `claude/relaxed-babbage-4bmpyh`
**Source brief:** "Orb Fast Start Safe Conversation Design" (2026-06-15)

> This document re-bases the original fast-start brief on the **actual state of
> the codebase as of 2026-06-15**. The brief is sound in spirit, but a code
> audit shows roughly a third of it is already built. Per the platform rule
> *"never rebuild systems that already exist"*, this design targets only the
> true remaining gap and explicitly flags where the brief conflicts with
> existing, locked systems.

---

## 0. Non-negotiable guardrail (unchanged from brief)

This is a **latency** change, not a conversation redesign. The following remain
authoritative for every real conversation turn and MUST NOT be removed,
simplified, or bypassed:

Brain/system-instruction assembly · bootstrap context pack · wake-brief
decisioning · Teacher Mode content · Journey greeting content · memory facts ·
role & language resolution · tool permissions/availability · transcript
persistence · safety/confirmation behavior.

The change is only about **when** this work happens relative to the click.

### Conversation invariants (carried verbatim, enforced in code + tests)

1. The wake cue is never persisted as an assistant transcript turn.
2. The wake cue never writes memory.
3. The wake cue never advances Journey state.
4. The wake cue never marks a Teacher lesson started/completed.
5. The wake cue never consumes or changes wake-brief eligibility.
6. Full context remains the only source of personalized Brain/memory/role/tool behavior.
7. If full context is not ready, Vitana may acknowledge presence but must not
   answer personalized/memory/medical/billing/tool prompts from minimal context.
8. If context assembly fails, the session fails open into a restricted,
   non-personalized mode and records telemetry.
9. The legacy synchronous path stays reachable behind a rollback flag.

---

## 1. What the audit found (this is the important part)

| Brief assumption | Reality in code (2026-06-15) | Consequence |
|---|---|---|
| `session/start` blocks on full **brain/bootstrap context** | **Already async.** Heavy Brain/bootstrap is deferred to `contextReadyPromise` (`live-session-controller.ts:710`, comment 707-710) and awaited later in `connectToLiveAPI`'s `ws.on('open')`. | The brief's headline premise is partly stale. Do **not** re-architect context assembly — it is already off the response path. |
| Wake-timeline telemetry must be built (Phase 0) | **Already built and LOCKED.** `services/gateway/src/services/wake-timeline/` — a 16-event recorder (`timeline-events.ts`), per-stage latency breakdown aggregates, `orb_wake_timelines` table, Command Hub panel (VTID-02917 / VTID-02927). | Phase 0 is essentially done. **Reuse it. Do NOT invent new event names** — the 16 names are explicitly locked by prior user instruction. |
| Guided-topic skip is "precedent to build" | **Already shipped** (VTID-03294, `live-session-controller.ts:721-743`) — resolves context in a ~0ms microtask to avoid the 7-10s delay. | This is the exact template to generalize. |
| WebSocket transport is future work | **Already opt-in** in the widget (`orb-widget.js`, `init({transport:'ws'})` / localStorage). SSE is default. | Phase 5 is a rollout/ramp exercise, not a build. |
| Flags need a new system | **Two exist:** env-var `feature-flags.ts` (`FEATURE_<NAME>_ENV`, runtime, rollback w/o redeploy) and DB-backed `system-controls-service.ts` (audited, 10s cache). | Use these. No new flag framework. |
| In-memory sessions / scaling | **Real constraint confirmed.** `liveSessions` is an in-memory `Map` (`live-session-registry.ts:58`); gateway pinned `--max-instances=1` (`EXEC-DEPLOY.yml`, `STAGE-DEPLOY.yml`) "until a shared session store lands." | Brief's caution is correct. Prewarm + scaling must not ship before shared state or strict WS ownership. |

### The actual remaining blockers on the `session/start` response

The HTTP response (`live-session-controller.ts:1474`) is returned only **after**
these still-synchronous awaits (the brain context is already excluded):

1. **Voice-quota reservation** — `await reserveVoiceQuotaAtSessionStart` (line 545). One Supabase round-trip.
2. **Wake-brief decision** — lines 1053-1311 (awaited inline; already best-effort/try-wrapped).
3. **Journey-greeting block** — lines 1322-1432 (awaited inline; already best-effort).
4. **OASIS `emitLiveSessionEvent`** — **`await`ed at line 1455** — pure telemetry on the critical path.

These four — not context assembly — are what the fast-start work must move off
the response path.

---

## 2. Revised phase plan (only the real gap)

### Phase 0 — Measurement ✅ already in place
Reuse the existing wake-timeline (16 LOCKED events + stage breakdown). **Action:
none beyond confirming the client-side `wake_clicked` mark fires** (it is the
t0 anchor for `time_to_first_audio_ms`). Do **not** add new event names; if a
new mark is genuinely required it needs explicit user approval to expand the
locked set.

### Phase 1 — Make telemetry non-blocking + prove parity harness  ← **THIS PR**
- **1a (shipped here):** Fire-and-forget the awaited `emitLiveSessionEvent`
  (line 1455). Telemetry must never block the wake path — this matches both the
  platform telemetry rule and the brief's item 7. The event is still emitted;
  we just stop blocking the user's response on the DB write. Behavior-preserving
  for the conversation; removes one round-trip from p50/p95.
- **1b (next):** Add a parity-test fixture harness that snapshots the resolved
  session fields (`active_role`, `lang`, `contextInstruction`,
  `wakeBriefOverrideBlock`, `journeyGreetingBlock`, `teacherModeContent`, tool
  config) so Phase 2's deferral can be proven to change *timing only*, not
  *content*.

### Phase 2 — Defer wake-brief + journey off the response path (flag-gated)  ✅ implemented (flag default off)
Behind `FEATURE_ORB_FAST_START_ENV` (default `off` → legacy inline behavior):
- The wake-brief decision + journey-greeting + turn-1 snapshot are wrapped in a
  closure (`assembleWakeBriefAndJourney`) in `live-session-controller.ts`. The
  body is **byte-identical** to the prior inline code (diff = pure insertions,
  zero deletions) — parity by construction.
- On the fast path the closure is **composed into the existing
  `session.contextReadyPromise`** via `composeContextReady()`, which the
  stream-open gate (`orb-live.ts` ~6178) already awaits before building the
  Gemini setup message. So the first **personalized** turn still carries full
  wake-brief / Teacher / Journey content; only the HTTP `session/start`
  response returns earlier.
- `composeContextReady` uses `Promise.allSettled` → a wake-brief/journey/brain
  rejection cannot reject the gate (fail-open, same as today's per-block
  try/catch).
- `meta.context_status` is `'pending'` on the fast path / `'ready'` on legacy;
  `meta.wake_brief` is `null` when pending — **widget must not depend on it
  synchronously** when `context_status==='pending'`.
- New logic (`shouldDeferWakeWork`, `composeContextReady`) is unit-tested
  (`test/orb-fast-start.test.ts`, 9 cases incl. default-off, gating, ordering,
  fail-open). The moved body needs no new test (parity by construction);
  end-to-end validation is the staging flag-on check via the existing
  `orb_wake_timelines` stage-breakdown.
- Anonymous + guided-topic sessions always run inline (they skip or already
  fast-path this work).
- **Remaining for a follow-up:** quota reservation still `await`s the hard-block
  gate (correct for billing); making its non-block path fail-open-fast
  (cache/timeout) is a separate small change.

### Phase 3 — Widget prewarm  ⚠️ gated on shared-state/strict-WS
Only after Phase 6 (or strict WS ownership). Prewarm creates extra unclaimed
sessions in the in-memory map — shipping it on `--max-instances=1` worsens the
scaling cliff. Reuse `system-controls-service` for `orb.prewarm.enabled`.

### Phase 4 — Cached wake phrase  ✅ implemented (flag default off; needs asset render + staging verify)
This is the change that actually kills the *perceived* 7-10s dead-air: the orb
plays Vitana's voice within ~1s of the tap while context + the Live model spin
up behind it.

- **Reuses the existing alert-clip system** (no new mechanism, no `speechSynthesis`):
  `render-orb-alert-clips.ts` → committed MP3 in Chirp3-HD (Vitana's voice) →
  `_preloadAlertClips` → `_playAlert`. Added `wake-cue-en` ("I'm here.") /
  `wake-cue-de` ("Ich bin da.").
- Widget plays the cue right after the activation chime, inside the user
  gesture (`orb-widget.js`), and **stops it the instant the real greeting audio
  arrives** (`audio_out` first-chunk) and on teardown. Short + non-committal so
  it never collides with the real wake-brief / Teacher / Journey opener.
- **Invariants honored:** local UI cue only — not a transcript turn, no memory
  write, no Journey/Teacher/wake-brief mutation (invariants 1-5). Verbatim
  reuse of the proven clip path.
- **Gating:** `_cfg.wakeCue` (default off) via `init({ wakeCue: true })`, or
  localStorage `vtorb.wakecue='on'` for per-browser staging verification
  (mirrors the `vtorb.transport` pattern).
- **Graceful no-op:** if the MP3 isn't rendered/committed yet, the preload 404s
  and the cue silently does nothing (no error tone) — so shipping the code
  before the asset is safe.

**Two gates before this reaches the community:**
1. **Render the assets** — run `npx tsx scripts/render-orb-alert-clips.ts` (default
   mode hits the deployed gateway TTS, no creds), commit `wake-cue-en.mp3` /
   `wake-cue-de.mp3`. *(I cannot run this — egress/TTS blocked in my env.)*
2. **Staging browser verification** — `orb-widget.js` is plain JS (not tsc-checked)
   and I cannot run a browser here, so this MUST be tapped on staging (flag on)
   and confirmed: cue plays in Vitana's voice within ~1s, stops cleanly when the
   real greeting starts, no double-audio, nothing written to transcript.

### Phase 5 — WS canary (ramp, not build)
WS transport already exists; ramp internal → 5% → 25% → 50% → 100% with the
existing wake-timeline `disconnect`/`reconnect_*` events as the safety signal.

### Phase 6 — Shared session state, then relax `--max-instances=1`
Redis/Memorystore (or strict WS ownership). Prerequisite for Phase 3 and any
horizontal scaling.

---

## 3. Flags (using the existing env-var system)

| Flag (env var) | Default | Purpose |
|---|---|---|
| `FEATURE_ORB_FAST_START_ENV` | `off` | Defer wake-brief + journey off response path (Phase 2). |
| `FEATURE_ORB_PREWARM_ENV` | `off` | Widget prewarm (Phase 3 — do not enable pre-shared-state). |
| `FEATURE_ORB_CACHED_WAKE_PHRASE_ENV` | `off` | Local spoken wake phrase (Phase 4). |
| `FEATURE_ORB_VOICE_WS_DEFAULT_ENV` | `off` | Make WS the default transport (Phase 5). |

`off` → legacy synchronous path (rollback = flip env var, no redeploy). All
flags graduate `off` → `staging-only` → `staging+prod`.

---

## 4. Success criteria (carried from brief)

| Metric | Target (p95) |
|---|---|
| Click → first audible cue | < 500 ms |
| Click → first spoken wake phrase | < 1000 ms |
| Click → personalized audio (warm) | < 2000 ms |
| `session/start` fast path | < 800 ms |
| Full context readiness after click | < 2500 ms |
| Context parity vs legacy | 100% on fixtures |
| Rollback | one env-var flip |

Measured via the existing `orb_wake_timelines.aggregates.time_to_first_audio_ms`
and `stage_breakdown`.

---

## 5. Conflicts with the brief (flagged, not silently followed)

1. **New wake-timeline event names** (`prewarm_started`, `audio_ready_sent`,
   `wake_cue_started`, …) — **conflict** with the LOCKED 16-name set
   (`timeline-events.ts:12-13`). Resolution: map prewarm/cache marks onto
   existing names where possible; expanding the locked set needs explicit user
   approval.
2. **"session/start blocks on full context"** — outdated; brain context is
   already async. Phase 2 targets wake-brief/journey/telemetry/quota instead.
3. **Prewarm before scaling** — brief lists shared-state as an "open question";
   here it is a **hard prerequisite** for Phase 3 (in-memory map + max-instances=1).

---

## 6. Governance

Per platform rules this requires a VTID with `spec_status=approved` before any
prod deploy. Post-cutover (we are past Mon 8 Jun 2026), merges to `main`
auto-deploy **staging only** (`preview-gateway.vitanaland.com`); production is
the PUBLISH button / escape-hatch. This design and all phase PRs verify on
staging first.
