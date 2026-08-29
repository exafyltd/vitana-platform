# Aurora Migration — B3 Dead-RPC Call-Site Audit

**No VTID self-allocated.** This session has no live gateway endpoint and no
Supabase credentials — the same "no live DB/AWS access" posture nearly every
prior session in this migration chain has recorded (see e.g. the 2026-08-19
CLAUDE.md changelog row, or `docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md`'s own
lineage). Per Part 1 IF-THEN rule 1/§4.1, the one real stop condition for
VTID allocation is the allocator being unreachable, which is the case here —
this is not a silent skip, it is the documented fallback the CLAUDE.md
change log itself has used before ("no gateway/DB access from this session
to self-allocate one"). Referenced here as the **VTID-03772 follow-up**
this doc's own "Next steps #2" asked for — see
`docs/AURORA-B3-RPC-PARITY-INVENTORY.md`'s closing addenda. A human/later
session with live access should allocate a real VTID for this doc when it
is committed, if the platform owner wants one on record.

**Scope.** `AURORA-B3-RPC-PARITY-INVENTORY.md` found 106 of 202 gateway-
called RPC names do not exist in the live Supabase `pg_proc` (verified
live, 2026-08-27) — every call fails with a real Postgres "function does
not exist" error, every time, in production, today. That doc's own
"Next steps #2" said the DB-existence finding is not the same claim as
"the call site is safe to delete" and asked for a per-call-site pass. This
is that pass. **Existence is trusted from the base doc and was not
re-verified here** (this session has no live DB access) — the entire
contribution of this document is call-site reachability, mounting, auth
gating, and error-handling behavior for each dead RPC's call site(s) in
`services/gateway/src` (and, where a name lives in `services/openclaw-bridge`
instead, there).

**Method.** Read `docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md` first to calibrate
tone/rigor — same discipline applied here: read the actual route file, find
the router mount in `index.ts`, check auth gating, and read exactly how a
Supabase `{ data, error }` result is handled (thrown, checked-and-500'd,
checked-and-503'd-with-a-message, or silently defaulted). For each of the
106 names, `grep -rn "\.rpc(['\"]<name>['\"]" services/gateway/src` found the
call site(s), then the file was read in enough context to answer the
questions in the task brief. No code was changed; nothing was deleted or
"fixed."

**A genuinely useful discovery that shaped how fast this pass could go:**
almost every RPC call site in this codebase has already been moved, by the
B1 workstream (VTID-03702), into a small `*-repository.ts` seam file (a
"pure move, not a rewrite" per each seam's own header comment) that does
nothing but wrap the raw `.rpc()` call. This meant finding "the call site"
and finding "the file that decides what happens on error" were almost
always two different, easy-to-locate files (`<feature>-repository.ts` for
the RPC name, `<feature>.ts`/`routes/<feature>.ts` for the HTTP behavior),
which made this audit far more tractable than reading 106 call sites cold.

## Coverage

**~104 of the 106 confirmed-dead RPC names have a call-site finding below.**
Two names could not be reconciled with confidence — see "Not yet covered"
at the end. The 36 names `AURORA-B3-RPC-PARITY-INVENTORY.md` listed
explicitly (the `d41`/`d43`/`d44`/`d45`/`d50` family plus `exec_sql`,
`kb_search`, `user_preferences_get_bundle`, `vtn_reward`, `vtn_spend`,
`vtn_transfer`) are all covered. Of the ~70 more named only by cluster in
that doc's addendum (`alignment_*`, `overload_*`, `location_*`,
`taste_*`/`taste_alignment_*`, `preference_*`, `relationship_*`, `social_*`,
`topics_*`, seven `memory_*` extensions, `longevity_*`, `match_*`, the
personalization/trust cluster, and `credit_wallet`), this pass
reconstructed and checked 68 by cross-referencing the "Auth-dependent (106)"
and "Portable (54)" tables against each named prefix — 2 short of the
doc's stated 70, and that gap is the "not yet covered" item.

**`credit_wallet` and the personalization/trust cluster
(`check_behavior_constraint`, `constraint_delete`, `constraint_set`,
`get_behavior_constraints`, `get_correction_history`,
`get_personalization_changes`, `get_trust_scores`, `inference_downgrade`,
`inference_reinforce`, `record_match_feedback`, `record_user_correction`,
`repair_trust`)** were already investigated in real depth by
`AURORA-B3-RPC-PARITY-INVENTORY.md`'s own addenda — full re-investigation
would duplicate work already done well. They're listed in the summary
table for completeness (their bucket carries over unchanged) with one new
observation each below, not a from-scratch re-audit.

## Summary table

Grouped by feature/file cluster rather than in the original doc's flat
alphabetical order, since almost every RPC in a cluster shares one route
file, one mount point, one auth gate, and one error-handling style.

| Cluster | RPC(s) | Calls | File(s) | Mounted? | Auth | Error handling | Severity |
|---|---|---:|---|---|---|---|---|
| **User Preferences (D27)** | `preference_bundle_get`, `preference_set`, `preference_delete`, `preference_confirm`, `preference_get_audit`, `constraint_set`, `constraint_delete`, `inference_reinforce`, `inference_downgrade` | 9 | `routes/user-preferences.ts` + `-repository.ts` | ✅ `/api/v1/user-preferences` | Bearer token, normal user | Loud — every route: `if (error) return res.status(500).json({ok:false, error:error.message})` | **(a) High — whole feature dead, loud** |
| **Locations (D34 REST surface)** | `location_add`, `location_checkin`, `location_get_visits`, `location_nearby_discovery`, `location_preferences_get`, `location_preferences_set` | 6 | `routes/locations.ts` + `-repository.ts` | ✅ `/api/v1/locations`, `/api/v1/discover`, `/api/v1/location` | Bearer token, normal user | Loud — 502 with `error.message` on every route | **(a) High** |
| **Taste & Lifestyle Alignment (D39)** | `taste_profile_get`, `taste_profile_set`, `taste_alignment_bundle_get`, `taste_alignment_audit_get`, `taste_reaction_record` | 5 | `routes/taste-alignment.ts` + `-repository.ts` | ✅ `/api/v1/taste-alignment` | Bearer token, normal user | Loud — 500 with `error.message` on every route | **(a) High** |
| **Relationship Graph** | `relationship_add_edge`, `relationship_get_signals`, `relationship_get_graph`, `relationship_update_signal` | 4 | `routes/relationships.ts` + `-repository.ts` | ✅ `/api/v1/relationships` | Bearer token, normal user | Loud — explicit "does not exist" branch → 503 with a named message; other errors → 502 | **(a) High** |
| **Social Context (D35)** | `social_compute_context`, `social_compute_proximity`, `social_get_comfort_profile`, `social_update_comfort_profile`, `social_invalidate_cache` | 5 | `routes/social-context.ts`, `services/d35-social-context-engine.ts` + `-repository.ts` | ✅ `/api/v1/social` | Bearer token, normal user | Loud — engine returns `{ok:false, error, message}`, route maps to 400 | **(a) High** |
| **Topics / Topic Profile** | `topics_get_user_profile`, `topics_recompute_user_profile`, `topics_create_registry_entry`, `topics_validate_keys`, `topics_get_registry` | 5 | `routes/topics.ts` + `-repository.ts` | ✅ `/api/v1/topics` | Bearer token, normal user | Loud — explicit "does not exist" branch → 503; `validateTopicKeys` has **no external callers**, so its failure is contained to `/topics/validate` only | **(a) High**, contained blast radius |
| **Longevity** | `longevity_compute_daily`, `longevity_get_daily`, `longevity_explain_daily` | 3 | `routes/longevity.ts` + `-repository.ts` | ✅ `/api/v1/longevity` | Bearer token, normal user | Loud — 502 `UPSTREAM_ERROR` with message | **(a) High** |
| **Matchmaking (gateway subsystem)** | `match_recompute_daily`, `match_get_daily`, `match_set_state` | 3 | `routes/matchmaking.ts` + `-repository.ts` | ✅ `/api/v1/match` | Bearer token, normal user | Loud — explicit "does not exist" → 503; else 502 | **(a) High, but reinforces B2's "superseded subsystem" finding — see prose** |
| **Social Alignment (D47)** | `alignment_act_on_suggestion`, `alignment_generate_suggestions`, `alignment_mark_shown`, `alignment_get_suggestions`, `alignment_cleanup_expired` | 5 | `routes/social-alignment.ts` + `d47-social-alignment-engine(-repository).ts` | ✅ `/api/v1/alignment` | Bearer token, normal user | Loud — engine `{ok:false}` → route 400/500 | **(a) High** |
| **Boundary & Consent (D41) — REST API** | `d41_get_personal_boundaries`, `d41_set_personal_boundary`, `d41_get_consent_bundle`, `d41_set_consent`, `d41_revoke_consent` | 5 | `routes/boundary-consent.ts` + `-repository.ts` | ✅ `/api/v1/boundaries` | Bearer token, normal user | Loud — 500 `{ok:false}` on every route | **(a) High** |
| **Boundary & Consent (D41) — ORB voice bridge** | same 2 read RPCs, reached a second way | (same RPCs, 2nd call site) | `services/orb-memory-bridge.ts` → `getOrbBoundaryContext()` in `d41-boundary-consent-engine.ts` | N/A (function, not a route) — called on **every ORB voice session** | N/A | **Fully silent** — RPC error logged only via `console.warn`, function returns `ok:true` with hardcoded protective defaults | **(b) Silent, hot path — see prose (direction is safe, but feature is dead)** |
| **Longitudinal Adaptation (D43)** | `d43_record_data_point`, `d43_get_data_points`, `d43_get_pending_adaptations`, `d43_create_adaptation_plan`, `d43_update_adaptation_status`, `d43_rollback_adaptation`, `d43_acknowledge_drift`, `d43_create_snapshot` | 8 (get_data_points called 3x, incl. from D45/D51) | `routes/longitudinal-adaptation.ts` + `d43-longitudinal-adaptation-engine(-repository).ts` | ✅ `/api/v1/longitudinal` | Bearer token or dev-sandbox | Mostly loud (400 with `{ok:false,error}`) — **but one secondary silent swallow inside `getEvolutionState()`**, see prose | **(a) High, with (b) footnote** |
| **Predictive Signal Detection (D44)** | `d44_create_signal`, `d44_get_active_signals`, `d44_get_signal_evidence`, `d44_get_signal_stats`, `d44_record_intervention`, `d44_update_signal_status` | 6 | `routes/signal-detection.ts` + `-repository.ts` | ✅ `/api/v1/predictive-signals` | Bearer token, normal user; also called by cron (`scheduled-notifications.ts`) | Loud — already investigated in depth, see `AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 2 (confirmed reachable from `vitana-v1`'s admin Intelligence → Signals page) | **(a) High — carried over from B2, not re-audited** |
| **Predictive Risk Forecasting (D45)** | `d45_store_window`, `d45_get_windows`, `d45_get_window_details`, `d45_acknowledge_window`, `d45_invalidate_window` | 5 | `routes/predictive-forecasting.ts` + `-repository.ts` | ✅ `/api/v1/forecast` | Bearer token, normal user | Loud — `{ok:false}` → route 400/500 | **(a) High** |
| **Positive-Trajectory Reinforcement (D50)** | `d50_get_last_reinforcement`, `d50_count_today_reinforcements`, `d50_store_reinforcement`, `d50_mark_delivered`, `d50_dismiss_reinforcement`, `d50_get_recent_reinforcements` | 6 | `routes/positive-trajectory-reinforcement.ts` + `-repository.ts` | ✅ `/api/v1/reinforcement` | Bearer token, normal user | Loud — same `{ok:false}` → 400/500 pattern as every D-series sibling | **(a) High** |
| **Overload Detection (D51)** | `overload_compute_baselines`, `overload_get_baselines`, `overload_record_pattern`, `overload_detect`, `overload_get_detections`, `overload_dismiss`, `overload_explain` | 7 | `routes/overload-detection.ts` + `-repository.ts` | ✅ `/api/v1/overload` | Bearer token or dev-sandbox | Loud — verified concretely on `POST /detect`: `!result.ok` → 500 with the result body | **(a) High** |
| **Environmental Mobility inference (D34, non-RPC-parity part)** | `user_preferences_get_bundle` | 1 | `services/d34-environmental-mobility-engine.ts` + `-repository.ts`, mounted via `routes/environmental-mobility-context.ts` | ✅ `/api/v1/context/mobility` | Reached from `orb-tools/awareness-tools.ts` too (ORB tool call) | **Fully silent** — `if (!error && data?.ok...)` skips the whole preference-inference branch on RPC failure; no warn, no log at all | **(b) Silent, no log trace at all** |
| **Memory Garden extensions** | `memory_retrieve`, `memory_get_garden_progress`, `memory_get_timeline`, `memory_build_timeline`, `memory_compute_quality`, `memory_get_quality` | 6 | `routes/memory.ts` + `-repository.ts` | ✅ `/api/v1/memory` | Bearer token, normal user | **Mixed** — 5 of 6 fail loud with an explicit, well-labeled 503 ("RPC not found, migration not deployed yet"); `GET /garden/progress` instead returns **200 OK** with a hardcoded all-zero placeholder object tagged `_placeholder:true` | **(a) High for 5 routes; (b) Silent-but-tagged for 1 — see prose** |
| **Memory write v2 (safe fallback, not a bug)** | `memory_write_item_v2` | 1 | `services/supabase-semantic-memory(-repository).ts` | ✅ (used by memory write path) | — | **Deliberately safe** — on "does not exist," falls back to `memory_write_item` (confirmed live) and logs a warning; no user-visible degradation beyond losing v2-only fields (e.g. embedding metadata) | **No action needed** |
| **`exec_sql` (voice budget watch)** | `exec_sql` | 1 | `routes/voice-budget-watch.ts` + `services/voice-budget-watch(-repository).ts` | ❌ **Required into a variable in `index.ts` but never passed to `mountRouterSync`/`app.use` — genuinely unreachable via HTTP** | Would have been `requireAdminAuth` if mounted | Loud (throws) if it ever ran, but it cannot be reached at all today | **(d) Lowest — not merely unused, structurally unmountable** |
| **`kb_search`, `vtn_reward`, `vtn_spend`, `vtn_transfer`** | 4 names | 4 | `services/openclaw-bridge/src/skills/vitana-knowledge.ts`, `vitana-vtn-wallet.ts` — **a different service from `services/gateway`**, contrary to the base doc's stated `services/gateway/src`-only method | N/A — the whole service has no live deploy | N/A | Loud (throws on error) inside a service that cannot run in production at all — see `AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 8 (its only deploy path, `EXEC-DEPLOY.yml`, is 100% GCP Cloud Run, and GCP is decommissioned) | **(d) Lowest — no running service to reach it in** |
| **`credit_wallet`** | 1 | 1 | `routes/billing.ts` | ✅ `/api/v1/billing/webhooks/stripe` | Stripe webhook (no end-user auth) | Loud (throws, Stripe retries and fails identically each time) | **Already fully investigated — see `AURORA-B3-RPC-PARITY-INVENTORY.md`'s addendum. Real money bug, not re-audited here.** |
| **Personalization/trust cluster** | `check_behavior_constraint`, `constraint_delete`\*, `constraint_set`\*, `get_behavior_constraints`, `get_correction_history`, `get_personalization_changes`, `get_trust_scores`, `inference_downgrade`\*, `inference_reinforce`\*, `record_match_feedback`, `record_user_correction`, `repair_trust` | 12 (4 marked \* are also counted under User Preferences above — same RPC names, two call sites: `routes/user-preferences.ts` AND `routes/feedback-correction.ts`) | `routes/feedback-correction.ts` (`check_behavior_constraint`, `repair_trust`, `record_user_correction`, `get_trust_scores`, `get_behavior_constraints`, `get_correction_history` — confirmed here) + others | ✅ `/api/v1/feedback` (per `AURORA-B3-RPC-PARITY-INVENTORY.md`'s own addendum) | Bearer token, normal user | Loud — `routes/feedback-correction.ts` uses the identical named-503 pattern as `user-preferences.ts`/`topics.ts`/`relationships.ts` | **(a) High — carried over from B3's own addendum, extended here to confirm the WHOLE `/api/v1/feedback/*` family (not just `/trust/repair`) is affected** |

**New cross-cluster finding not called out by the base doc:** `constraint_set`,
`constraint_delete`, `inference_reinforce`, and `inference_downgrade` are
each dead **twice over**, in two independently-mounted, independently
authenticated features (`/api/v1/user-preferences/*` and
`/api/v1/feedback/*` presumably share the underlying constraint/inference
tables conceptually, but call the RPCs from two separate route files with
two separate error-handling implementations). Neither masks the other —
both are independently loud — but it means the "personalization/trust"
and "D27 preferences" features, which read as two different products in
the route layer, are actually built on the exact same missing DB layer.

## Prose detail — the findings that need more than one table row

### 1. The entire `/api/v1/user-preferences/*` feature (D27) is dead, and it is the single largest concentration of confirmed-dead RPCs in one file

Every route in `routes/user-preferences.ts` except `/`, `/health`, and
`/categories` (which serve static metadata, no RPC) calls a dead RPC:
`GET /bundle`, `POST /preference`, `DELETE /preference`, `POST
/constraint`, `DELETE /constraint`, `POST /confirm`, `POST /reinforce`,
`POST /downgrade`, `GET /audit` — nine call sites, nine of the 106 dead
names, one file. `POST /check` doesn't call an RPC directly but depends on
`preference_bundle_get` via an internal fetch, so it fails too. Every one
of these fails loud (`res.status(500).json({ok:false, error:error.message})`)
— a real user hitting any of these gets a clear, immediate, informative
failure. This is good in the sense that nobody is being lied to, but it
means an entire documented, mounted, authenticated REST feature — "D27
Core Intelligence - User Preference & Constraint Modeling Engine," per its
own route-file header — has **never worked**, not degraded, not partial:
every single one of its nine mutating/reading operations 500s.

### 2. `d41`'s ORB voice bridge silently substitutes hardcoded "protective" defaults for the user's real boundaries/consent — on every voice session, with zero error trace

Unlike `routes/boundary-consent.ts` (loud, per the table), the second call
site for the same underlying data — `getOrbBoundaryContext()` in
`services/d41-boundary-consent-engine.ts`, invoked from
`services/orb-memory-bridge.ts` on presumably every ORB voice session
(it's called to build the ORB system-prompt boundary/consent context) —
handles the RPC failure completely differently:

```ts
// getPersonalBoundaries():
if (result.error) {
  console.warn(`${LOG_PREFIX} RPC error (get_boundaries):`, result.error.message);
  // Return defaults on error
  return { ok: true, boundaries: DEFAULT_BOUNDARIES };
}
```

`getConsentBundle()` does the identical thing for consent, defaulting to
an empty, `default_stance: 'protective'` bundle. Both return `ok: true` —
the caller (`getOrbBoundaryContext`) never learns the RPC failed at all,
so **there is no code path in this whole chain that could ever surface
this failure to a log a human would notice**, only a `console.warn` two
layers down that nothing aggregates or alerts on.

**Why this is lower-severity than it sounds, and why it's still worth
fixing:** the direction of the silent default is *safe* — "protective"
consent stance, generic default boundaries — not permissive. Nobody's
private data gets over-shared because this RPC is missing; if anything the
opposite (a user who explicitly *loosened* a boundary or *granted* a
consent gets the protective default instead, which is annoying, not
dangerous). But it means: (a) the personal-boundaries/consent-preferences
feature has been **completely inert inside ORB** for as long as these RPCs
have been missing — a user who thinks they configured "don't ask about my
finances" via the `/api/v1/boundaries` UI (which itself 500s if they ever
tried) has zero effect on what ORB actually does, and (b) nobody
monitoring the system would ever know, because the failure is designed to
look exactly like "everything is fine, using sensible defaults."

### 3. `memory_get_garden_progress` returns HTTP 200 with a hardcoded all-zero "Memory Garden" — tagged, but likely invisible to a naive frontend caller

`GET /api/v1/memory/garden/progress` is the one memory-route exception to
the otherwise-consistent "503 with a named-RPC message" pattern the rest
of `routes/memory.ts` uses. On "does not exist," it returns:

```json
{
  "ok": true,
  "totals": { "memories": 0 },
  "categories": { "personal_identity": { "count": 0, "progress": 0.00, ... }, ... },
  "_placeholder": true
}
```

The `_placeholder: true` flag means this is not silent in the strict sense
— a careful caller *can* detect it. But it is a 200-OK, `ok:true` response
that looks, to any consumer that doesn't specifically check for
`_placeholder`, exactly like "you have a completely empty Memory Garden in
every one of 13 categories." Whether the frontend's Memory Garden screen
checks for this flag was not verified here (out of this repo's scope) —
flagging it as the kind of response shape that invites exactly the
"quietly wrong instead of loudly broken" bug class this whole audit exists
to catch.

### 4. D34 (environmental/mobility inference) silently drops a preference-based confidence boost, with literally no log line at all

`services/d34-environmental-mobility-engine.ts`'s mobility-profile
inference step:

```ts
if (supabase && profile.confidence < 70) {
  try {
    const { data, error } = await repo.fetchUserPreferencesBundle(supabase);
    if (!error && data?.ok && data.preferences) {
      // ...boost confidence from health/activity preferences...
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to get user preferences:`, err);
  }
}
```

Since `user_preferences_get_bundle` doesn't exist, Supabase returns `{data:
null, error: {...}}` — not a thrown exception — so the `catch` block (the
only place that logs anything) never runs. The `if (!error && ...)` guard
simply evaluates false and the whole block is skipped with **zero
console output of any kind**. The practical effect is small (a mobility
confidence score that never gets boosted past its baseline via this one
signal), but it's worth naming as the quietest failure mode found in this
whole pass — quieter even than the d41 case above, which at least logs a
`console.warn` two layers down.

### 5. `d43`'s `getEvolutionState()` has its own, smaller, likely-moot silent swallow

`GET /api/v1/longitudinal/state` is loud overall (`detectDrift()`'s own
RPC failures propagate to a 400), but inside `getEvolutionState()`,
`d43_get_pending_adaptations`'s result is handled as:

```ts
const { data: pendingPlans, error: planError } = await repo.fetchD43PendingAdaptations(supabase, 5);
// ...
pending_adaptations: planError ? [] : (pendingPlans || []),
```

`planError` is never logged and never fails the request — it only decides
whether `pending_adaptations` falls back to `[]`. In practice this branch
is very likely unreachable in its "quietly wrong" form: `detectDrift()`
(called earlier in the same function) depends on `d43_record_data_point`/
`d43_get_data_points`, both also confirmed dead, so the function almost
certainly returns the loud 400 before ever reaching this line. Recorded
for completeness — it's dead code inside dead code, not a live gap — but
worth fixing alongside the rest of D43 rather than assuming it's provably
inert without a live trace.

### 6. `exec_sql`'s route is not merely dead-RPC-broken — it is structurally unreachable via HTTP today, independent of the RPC question

`services/gateway/src/index.ts` does:

```ts
const voiceBudgetWatchRouter = require('./routes/voice-budget-watch').default;
```

— and that is the **only** occurrence of `voiceBudgetWatchRouter` in the
whole file. It is never passed to `mountRouterSync` or `app.use`. Express
never registers this router on any path, so `GET /voice-budget-watch`
(which would have been `requireAdminAuth`-gated had it been mounted)
cannot be reached by any HTTP request, regardless of whether `exec_sql`
exists. No cron, no other module, and no test import calls
`fetchVoiceBudgetWatch()` either. This is the one finding in this audit
where "reachable?" resolves to a clean, structural no — not "probably
unused" but "cannot be hit at all short of editing `index.ts`."

### 7. `kb_search`/`vtn_reward`/`vtn_spend`/`vtn_transfer` live in a different service than the base doc's own stated method covered

`AURORA-B3-RPC-PARITY-INVENTORY.md`'s Method section says explicitly its
scan covered "every `.rpc('name')` call site in `services/gateway/src`" —
but these four names' actual call sites are in
`services/openclaw-bridge/src/skills/vitana-knowledge.ts` and
`vitana-vtn-wallet.ts`, a **separate service**. (`services/gateway/src`
has zero occurrences of any of these four names today — confirmed by a
direct grep across the whole file tree, not just the gateway.) This is
worth flagging as a minor methodology note for whoever maintains that
doc's inventory going forward — the discrepancy doesn't change this
audit's conclusion, though: `AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 8
already established that `openclaw-bridge`'s only deploy path
(`EXEC-DEPLOY.yml`) is 100%-GCP and GCP is fully decommissioned, so there
is no running instance of this service in production at all today. All
four RPC calls fail loud (`throw new Error(...)` on error) *if* the code
ever executed — but there is currently nowhere for it to execute. Lowest
practical severity of anything in this document, for the same reason B2
already gave: not a reachability question inside the service, a
reachability question about the service itself.

### 8. Matchmaking's dead RPCs reinforce, rather than add to, B2's "superseded subsystem" finding

`match_recompute_daily`, `match_get_daily`, and `match_set_state` (in
`routes/matchmaking.ts`) are the RPC-layer counterpart to the three dead
**tables** (`matches_daily`, `match_targets`, `user_match_preferences`)
`AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 4 already flagged as likely
superseded by `vitana-v1`'s edge-function-based `daily_matches` matching
feature. All three RPCs fail loud (`routes/matchmaking.ts` explicitly
checks for "does not exist" and returns 503, else 502) — same loud
failure mode as everything else audited here, and the same read applies:
this whole subsystem looks like an earlier gateway-side matchmaking
implementation that a different, frontend-facing system replaced, not
three unrelated broken calls. Not a new finding, just confirmation at a
second layer.

## Severity summary across the ~104 covered RPCs

- **(a) Reachable, mounted, normal-user-facing, loud failure** — the large
  majority: all of D27 User Preferences (9), Locations (6), Taste
  Alignment (5), Relationships (4), Social Context (5), Topics (5, minus
  the contained `/validate` blast radius), Longevity (3), Matchmaking (3),
  Social Alignment (5), Boundary/Consent REST (5), Longitudinal Adaptation
  (8), Signal Detection (6, per B2), Predictive Forecasting (5),
  Positive-Trajectory Reinforcement (6), Overload Detection (7), 5 of 6
  Memory Garden extensions, and the Feedback/Trust family (per B3's own
  addendum, extended here). These are broken features, but nobody is
  fooled by a fake success — every one produces a clear 500/502/503 with a
  message.
- **(b) Reachable, silently degraded, no visible failure** — three found:
  the D41 ORB voice bridge (protective-default substitution, hot path, no
  aggregated log signal), the D34 mobility-inference preference boost (zero
  log output at all), and `memory_get_garden_progress`'s tagged-but-easy-
  to-miss placeholder response. A fourth, much weaker case (`d43`'s
  `pending_adaptations` fallback) is very likely masked by an earlier loud
  failure in the same function.
- **(c) Admin/internal only** — none newly found in this pass beyond what
  B2/B3 already covered for Signal Detection (admin Intelligence screen)
  and `credit_wallet` (a Stripe webhook, not a browsing surface).
- **(d) Mounted but no realistic caller, or not mounted at all** —
  `exec_sql` (never mounted, full stop) and the `openclaw-bridge` cluster
  (`kb_search`, `vtn_reward`, `vtn_spend`, `vtn_transfer` — no running
  service to call them in).
- **No action needed** — `memory_write_item_v2`'s fallback to the
  confirmed-live `memory_write_item` is a genuinely safe, already-correct
  degrade.

## Not yet covered

- **A 2-name reconciliation gap.** `AURORA-B3-RPC-PARITY-INVENTORY.md`'s
  addendum states its 70 newly-confirmed-dead names include `alignment_*
  (5)`, `overload_* (7)`, `location_* (6)`, `taste_*`/`taste_alignment_*
  (5)`, `preference_* (5)`, `relationship_* (4)`, `social_* (5)`, `topics_*
  (5)`, seven named `memory_*` extensions, `longevity_* (3)`, `match_* (3)`,
  the 12-name trust cluster, and `credit_wallet` — which sums to 68, not
  70, by this pass's own reconstruction (shown working in this session's
  scratch notes, not reproduced here). Two names are missing from this
  audit as a direct consequence — most likely somewhere in the
  `capacity_*` family (`capacity_compute`, `capacity_get_current`,
  `capacity_override`, `capacity_filter_actions` all appear in the base
  doc's Auth-dependent/Portable tables but were **not** named in the
  addendum's cluster list, so this pass treated them as *not* confirmed
  dead and did not audit their call sites) or `community_*`/`offers_*`
  (same shape: present in the tables, absent from the addendum's naming).
  **This is a real gap, not a rounding error** — whoever has live
  `pg_proc` access next should re-run the addendum's existence check
  specifically against `capacity_*`/`community_*`/`offers_*` to settle
  which two names (if any of these) actually belong on the dead list, and
  audit their call sites the same way this document did for everything
  else.
- **`d44` (Signal Detection) and `credit_wallet`/the trust cluster** were
  deliberately not re-investigated from scratch, per the task's own
  instruction — they carry over the base doc's existing, already-thorough
  findings unchanged (with one small extension: confirming the trust
  cluster's *whole* `/api/v1/feedback/*` family, not only `/trust/repair`,
  is affected).
- **No frontend (`vitana-v1`) cross-check was performed** for any of the
  clusters in this document except where the base docs already did one
  (Signal Detection's admin Signals page, matchmaking's superseded-by
  read). Whether `vitana-v1` actually calls
  `/api/v1/user-preferences/*`, `/api/v1/taste-alignment/*`,
  `/api/v1/social/*`, `/api/v1/topics/*`, `/api/v1/longevity/*`,
  `/api/v1/alignment/*`, `/api/v1/boundaries/*`, `/api/v1/longitudinal/*`,
  `/api/v1/forecast/*`, `/api/v1/reinforcement/*`, or `/api/v1/overload/*`
  from a real, currently-shipped screen was not checked — this document
  establishes that each is reachable *by any HTTP caller* (curl, mobile
  app, a frontend screen), not that a real screen currently calls it. That
  would be the natural next step for anyone deciding which of these
  "(a) High" findings is worth prioritizing first.

## What this does and doesn't mean

Nothing here was fixed, and nothing should be inferred as a
recommendation to delete any of these call sites. Per the task this
document was written for: "the DB function is confirmed gone" plus "the
call site is reachable and fails loud/silent" is still not the same claim
as "this feature should be removed" — several of these (D27 preferences,
D41 boundaries/consent, D39 taste alignment, D35 social context) read as
substantial, deliberately-designed features whose application layer
shipped ahead of their database layer, the same pattern B2 already named
for `adaptation_plans`/`user_topic_profile`. Whether the right fix is
"finally ship the missing migrations" or "retire the feature" is a
product decision, not something this audit is positioned to make.
