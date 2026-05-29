# R0 — ORB Wake Timeline Validation + First Evidence Report

**VTID:** VTID-02927
**Slice:** R0 (reliability evidence, measurement only — no tuning)
**Status:** awaiting first production data window

## Scope (locked)

- Confirm production is emitting the full wake/session timeline.
- Build/read the cohort view that answers "where does latency live"
  and "which stage drops sessions".
- Produce a first 24–48h report, **not a fix**.
- No tuning of timeouts, reconnect behavior, greeting thresholds, or
  fallback behavior in this slice. Optimizations land *after* this
  report makes the failure modes legible.

## How to fill this in

1. Deploy the gateway with this code on `main`.
2. Wait 24–48h for real production wake sessions to accumulate.
3. Open Command Hub → Voice → Journey Context (operator role required).
4. Read the **Wake Reliability Analysis** panel.
5. Pull the raw cohort via
   `GET /api/v1/voice/wake-timeline/analysis?limit=500` and paste
   the JSON snippet into the appendix below.
6. Fill the sections below. **Don't propose fixes here — that's R1.**

---

## 1. Telemetry completeness

Tick each event that the cohort confirms is firing in production. Use
the "Milestone reach" rows on the Wake Reliability panel.

| Event | Confirmed firing? (Y/N) | Notes |
|---|---|---|
| `wake_clicked` (FE) | | If N, vitana-v1 PR #454 may not be live |
| `client_context_received` (FE) | | Deferred from B0d.4 — likely N until follow-up |
| `ws_opened` (FE) | | Deferred from B0d.4 — likely N until follow-up |
| `session_start_received` (gateway) | | B0d.3 ships this; should be Y |
| `session_context_built` | | Not yet wired; expected N |
| `continuation_decision_started` (gateway) | | B0d.4 ships this; should be Y |
| `continuation_decision_finished` (gateway) | | B0d.4 ships this; should be Y |
| `wake_brief_selected` (gateway) | | B0d.4 ships this; should be Y |
| `upstream_live_connect_started` | | Not yet wired; expected N |
| `upstream_live_connected` | | Not yet wired; expected N |
| `first_model_output` | | Not yet wired; expected N |
| `first_audio_output` (FE) | | vitana-v1 PR #454 |
| `disconnect` (gateway) | | B0d.3 ships this; should be Y |
| `reconnect_attempt` | | Not yet wired; expected N |
| `reconnect_success` | | Not yet wired; expected N |
| `manual_restart_required` | | Not yet wired; expected N |

**Coverage gaps blocking real diagnosis:** _list any N rows that look
load-bearing for the question being asked. These are the next
instrumentation slices, NOT tuning work._

---

## 2. Where the latency lives

From the **Stage breakdown (p90)** rows on the panel:

| Stage | n | p50 | p90 | p99 |
|---|---|---|---|---|
| `wake_clicked → gateway` | | | | |
| `gateway → continuation_decision_finished` | | | | |
| `decision → upstream_live_connected` | | | | |
| `upstream → first_audio_output` | | | | |

**Reading:** the stage with the highest p90 is where wake latency
lives. Sample size matters — small `n` means provisional finding.

**Conclusion (one sentence, evidence only):** _e.g. "The
gateway→decision stage is fast (p90 < 30ms); the
upstream→first_audio stage owns the wake latency at p90 = 1400ms."_

---

## 3. Which stage drops sessions

From the **Milestone reach** rows on the panel. The drop between two
adjacent milestones names a failure stage.

| Milestone | Sessions reached | Drop-off from prior |
|---|---|---|
| `wake_clicked` | | — |
| `session_start_received` | | |
| `continuation_decision_finished` | | |
| `upstream_live_connected` | | |
| `first_audio_output` | | |
| `disconnect` | | (not a drop — every session eventually disconnects) |

**Largest drop-off:** _name the milestone-pair with the biggest gap.
That is "which stage drops sessions"._

---

## 4. Unknown disconnects

From the **Disconnects** row on the panel.

- Total disconnects: __________
- Unknown (no `disconnect_reason`): __________
- Unknown %: __________

**Reading:** any unknown rate above zero means there are disconnect
paths the gateway can't classify. Each one is a new instrumentation
target (a missing `disconnect_reason` metadata key in the emission
site).

**Top disconnect reasons (paste the `by_reason` map):**
```
<paste here>
```

---

## 5. Sample reconstructions

The Reliability Analysis panel surfaces one successful + one failed
session ID. Walk both manually via
`GET /api/v1/voice/wake-timeline?sessionId=<id>` and paste here.

### 5a. One successful wake (end-to-end)

- Session id: __________
- `wake_clicked` → `first_audio_output`: __________ ms total
- Event trail (event → tSessionMs):
  ```
  <paste timeline.events here>
  ```

### 5b. One failed/slow wake (concrete missing segment)

- Session id: __________
- Missing stage (from panel): __________
- Event trail (event → tSessionMs):
  ```
  <paste timeline.events here>
  ```
- Disconnect reason or `unknown_with_context`: __________

---

## 6. Conclusions

**One paragraph, evidence only.** Where is the slow-start pain? Where
do sessions drop? How blind are we (unknown %)? Do NOT propose fixes.

___________________________________________________________________

___________________________________________________________________

___________________________________________________________________

## 7. Acceptance checks

- [ ] Timeline events correlate by `session_id` / `decision_id` —
      same session reconstructable end-to-end from the audit log.
- [ ] At least one successful wake path reconstructed (§5a).
- [ ] At least one failed/slow path reconstructed (§5b) with a
      concrete missing or delayed segment named.
- [ ] Unknown disconnects counted explicitly (§4 unknown_pct).
- [ ] **No tuning code shipped in this slice.** R0 is measurement only.

## Appendix: raw cohort JSON

```json
<paste GET /api/v1/voice/wake-timeline/analysis?limit=500 here>
```

## Next steps (NOT in this report)

Once §1 confirms the events fire, §2 names the slowest stage, and §3
names the drop-off stage — that report drives the next slice:

- **R1**: targeted instrumentation in the named slow/drop stage (add
  missing events so we can drill in further).
- **R2**: ONLY after R1 makes the failure mode legible — the actual
  tuning slice (timeouts, reconnect backoff, audio-buffer keep-alive,
  greeting-latency threshold). One change at a time, each tied to
  evidence from this report.

Do not skip ahead. The measure-before-optimize discipline is what
makes the next round of fixes actually fix something.
