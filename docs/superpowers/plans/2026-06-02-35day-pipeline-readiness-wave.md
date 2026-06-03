# 35-Day Plan — Pipeline-Readiness Wave (2026-06-02)

**Mode**: full-autonomous takeover of the 35-day GCloud training plan (operator-directed).
**Scope**: code/config readiness only. No job submission, no deploy, no prod write — all gated
behind the operator switches below.

## What this wave shipped (draft PRs, CI-green)

| PR | Lane | Effect |
|---|---|---|
| #2515 | ft-quota | Accelerator/machine/region now operator-configurable on `CRON-FINETUNE-TRAINER` (defaults unchanged: L4/us-central1). Lets the operator re-submit the L4-`PENDING` job to capacity that has quota → training actually starts. |
| #2516 | dataset-ready | Read-only PREVIEW mode for `CRON-DATASET-EXTRACTION` (row counts by tenant/source, no write). Verified the consent gate + query correctness. **Surfaced the zero-fuel gap below.** |
| #2517 | shadow-emit | Fixed dropped `eval.shadow.compared` emits on Cloud Run (`min-instances=0` de-allocates CPU after response). Awaitable emit; retires the W3-B1 dual-emit workaround. |
| #2518 | emitter-align | **The critical fix.** See below. |
| — | test-drift | Already resolved on main (#2486) — no PR. |

## Critical discovery: the voice-tool-router training path was DEAD

The dataset preview (#2516) exposed, and #2518 confirmed with file:line evidence, that the
`voice-tool-routing` corpus would extract **0 rows even after consent + GPU**:

1. The extractor projects on `metadata.tool_name` / `tool_call.name` / `transcript` /
   `input_text`; the `orb.turn.responded` emitter never set any of them.
2. Worse: `emitOrbTurnResponded` had **no call site** — it was dead code. LiveKit's
   `session.py` never emits the event at all. So **neither transport produced any rows.**

#2518 fixes it: emits the extractor-aligned fields, wired into the Vertex `turn_complete`
handler, under a **strict consent/PII gate** (raw transcript only when `data_export_ok=true`
AND not guardrail-excluded; fail-closed otherwise). LiveKit equivalent specced as a
`docs/patches/orb-agent/` patch (session.py is out-of-sandbox).

**Implication:** without #2518, flipping consent + burning GPU credits would train on an
empty corpus. This gap was invisible in the dashboards until a real agent traced it.

## The three operator switches to REAL training (revised from two)

1. **Merge** the wave (#2515–#2518) — governed.
2. **GPU**: re-run the trainer at quota'd capacity (enabled by #2515):
   `gh workflow run CRON-FINETUNE-TRAINER.yml --ref main -f target=voice-tool-router -f accelerator_type_override=NVIDIA_TESLA_A100 -f machine_type_override=a2-highgpu-1g` (or `-f region_override=us-east1` to keep L4). → **credits start burning.**
3. **Consent**: flip `tenant_settings.feature_flags.data_export_ok=true` for consented prod
   tenants (business/legal). → consented turns now carry real tool/transcript fields (#2518)
   → 24–48h accumulation → `CRON-DATASET-EXTRACTION` (verify non-zero via #2516 preview) →
   fine-tune has fuel → model → canary soak → staging serves it.

Steps 2 and 3 are operator-only; I cannot and should not run them from the sandbox.
