# Handoff — Voice Improve cockpit quality score (resume here)

**Why this file exists:** the prior session was blocked because the sandbox's
network policy refused Supabase (`Host not in allowlist`), and a running
container can't pick up an allowlist/secret change mid-session. This doc +
`scripts/voice-validation.py` let a **fresh session** resume in one command.

Branch: `claude/funny-carson-DMTJh`.

---

## 0. First thing to do in the new session

Confirm Supabase is reachable and creds are present as **env secrets**
(not pasted in chat — the earlier key was exposed and should be rotated):

```bash
env | grep SUPABASE          # expect SUPABASE_URL + SUPABASE_SERVICE_ROLE
python3 scripts/voice-validation.py
```

If you still see `403 Host not in allowlist`, the allowlist change didn't take
— verify the host saved is `inmkhvwdcuyhnxkgfvsb.supabase.co` (or
`*.supabase.co`), no `https://`/trailing slash, then start another fresh
session. The script is **read-only** (PostgREST SELECT only); it writes nothing.

---

## 1. The situation

Voice Improve cockpit quality score sits at ~**40/100**. Score math
(`voice-improvement-aggregator.ts:164-173`): start 100, **−15 per critical,
−5 per warning, −1 per info**, floor 0. So `40 = 100 − 3×15 − 3×5` → **3
criticals + 3 warnings**.

The **3 criticals** are `self_healing_log` rows with `outcome='rolled_back'`
for failure_class `model_under_responds`
(`voice-improvement-aggregator.ts:405`). The auto-heal loop keeps trying to
"fix" under-responds, the fix rolls back, → critical, → after
`failed_fix_threshold` (4) it quarantines (`voice-recurrence-sentinel.ts:288`).

**Hypothesis (code-verified, data-pending):** those `model_under_responds`
signals are **false positives from echo counter-inflation** — the same bug
class as merged PR #2397.

---

## 2. Code evidence already gathered (verified, not guessed)

`audio_in_chunks` is incremented in **four** places in
`services/gateway/src/routes/orb-live.ts`, but **three of them are for chunks
that are dropped and never forwarded to Gemini**:

| line  | branch                                   | forwarded? |
|-------|------------------------------------------|------------|
| 12253 | `navigationDispatched` (widget closing)  | **no**     |
| 12268 | `isModelSpeaking` — **echo-prevention gate** | **no**  |
| 12276 | post-turn cooldown                       | **no**     |
| 12281 | real path → `sendAudioToLiveAPI`         | yes        |

The `model_under_responds` classifier compares `audio_in / audio_out`. On
mobile without hardware AEC, the speaker output is picked up by the mic while
the model talks; those echo chunks hit the 12268 gate — **dropped, but still
counted as `audio_in`**. The more the model talks, the more echo is counted,
the worse the ratio, the more a *healthy talkative* session is misclassified
as "under-responds." → ghost fix → rollback → quarantine. That's the 40.

There is **no forwarded-only counter today**. Adding one is **Track A**.

---

## 3. What's already shipped

- **PR #2397** (`9353319f`, on this branch): excludes phantom lifecycle
  session-stops (`superseded_by_new_session`, `expired_ttl`) from the
  "audio-in-zero" headline metric. Adds pure predicate
  `isLifecycleArtifactStop()` + 6 unit tests. **CI green, no actionable review
  comments, ready to merge.** Merging (VTID in squash msg) triggers
  AUTO-DEPLOY → EXEC-DEPLOY; verify EXEC-DEPLOY actually dispatched (see
  CLAUDE.md §16 — Auto Deploy "success" ≠ deployed).

---

## 4. Run the validation, then act on the output

`python3 scripts/voice-validation.py` prints four blocks:

- **Q1** — phantom vs real audio-in-zero. Confirms PR #2397's impact (the gap
  between before/after filter = phantom inflation removed).
- **Q2** — the rolled_back criticals (and how many are `model_under_responds`).
- **Q3** — recent session metrics. **This validates Track A:** sessions that
  *produced output* (`audio_out>0 AND turns>0`) yet show a high
  `audio_in/audio_out` ratio are the false under-responds. If these are
  common → hypothesis confirmed → build Track A.
- **Q4** — open quarantines = Track B release candidates.

### Track A — the score lever (do ONLY after Q3 confirms)
Add a forwarded-only counter and switch the classifier to it. Surgical,
additive, mirrors the #2397 approach. Sketch:
1. Add `audioInForwarded: number` to the session type (init 0).
2. Increment it **only on the real forward path** in `orb-live.ts` (the 12281
   branch, ideally only when `sent === true`), NOT in the 12253/12268/12276
   drop branches.
3. Emit it on `vtid.live.session.stop` metadata as `audio_in_forwarded_chunks`.
4. Point the `model_under_responds` classifier at
   `audio_in_forwarded` instead of raw `audio_in_chunks`.
5. Keep raw `audio_in_chunks` for back-compat. Unit-test the classifier with
   an echo-heavy fixture (high raw in, low forwarded, healthy audio_out → must
   NOT classify as under-responds).
6. **Do not** touch the echo gate's behaviour — only the counting/metric.

### Track B — release the false quarantines (governed, NOT a raw DB write)
Endpoint: `POST {GATEWAY}/api/v1/voice-lab/healing/quarantine/release`
(VTID-01962, `voice-lab.ts:944`). Body `{ class, normalized_signature }`.
Moves `quarantined → probation` (72h, halved thresholds). **Needs an admin /
gateway token, not the Supabase service-role key.** Release each
`model_under_responds` entry Q4/Q3 confirm as false. Each clears a critical
(+15).

### Track C — the 3 warnings
Enumerate from Q2 (escalated rows) + architecture-report items
(`voice-improvement-aggregator.ts:225+`) and triage. Each is −5.

---

## 5. Key files / refs

| thing | location |
|-------|----------|
| echo gate + counters | `services/gateway/src/routes/orb-live.ts:12250-12330` |
| classifier metric read | `services/gateway/src/routes/orb-live.ts:10380-10460` |
| score math | `services/gateway/src/services/voice-improvement-aggregator.ts:164-173` |
| criticals source | `voice-improvement-aggregator.ts:405` (self_healing_log rolled_back) |
| quarantine logic | `services/gateway/src/services/voice-recurrence-sentinel.ts` |
| release endpoint | `services/gateway/src/routes/voice-lab.ts:944` (VTID-01962) |
| quarantine table | `voice_healing_quarantine` (status: active/quarantined/probation/released) |
| PR #2397 commit | `9353319f` |

**Order of operations:** run script → if Q3 confirms, build Track A (validate
post-deploy too) → Track B release confirmed-false quarantines → Track C
triage warnings → re-check the score.
