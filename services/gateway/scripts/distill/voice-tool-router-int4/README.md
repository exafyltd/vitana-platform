# INT4 distillation — voice tool router

Phase 1 W4 (VTID-03179 FINETUNES placeholder).

The Phase 1 plan distills the voice tool router fine-tune to INT4 (~1.2 GB)
in W4 once it has reached 100% of staging traffic and held quality. Until
then this directory is intentionally empty.

When W4 starts, populate with:

- `quantize.py` — wraps `optimum-cli onnxruntime quantize` against the
  HF-format LoRA + base model
- `benchmark.py` — runs the INT4 vs FP16 comparison against the W1 golden
  corpus
- `config.yaml` — target latency, target accuracy, AWS readiness flags

Output lands under `gs://vitana-artifacts-staging/finetune-runs/voice-tool-router/<runId>/distilled/int4/`.
