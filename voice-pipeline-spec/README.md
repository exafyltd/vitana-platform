# voice-pipeline-spec

Canonical specification and parity scanner for the Vitana voice pipeline.

## Why this folder exists

Vitana operates two voice pipelines mutually-exclusively:

- **Pipeline A — Vertex Live** (TypeScript, `services/gateway/src/routes/orb-live.ts`)
- **Pipeline B — LiveKit cascade** (Python, `services/agents/orb-agent/`, planned)

The biggest risk in a long-lived parallel architecture is that one implementation grows new features and the other silently falls behind. By the time we want to flip the active provider, behaviour has diverged invisibly.

This folder is the structural answer:

1. **`spec.json`** is the single source of truth — every tool, OASIS topic, watchdog constant, and system-instruction parameter that BOTH implementations must expose.
2. **`tools/extract-ts.ts`** statically extracts the actual surface of `orb-live.ts` (via `ts-morph`).
3. **`tools/extract-py.py`** statically extracts the actual surface of `services/agents/orb-agent/` (via `libcst`). Stub today; activates when the Python service ships.
4. **`tools/diff.ts`** does a three-way diff: spec ↔ vertex-extract ↔ livekit-extract. Drift is categorised (`missing_in_*`, `arg_schema_mismatch`, `value_mismatch`, `undeclared`, `static_runtime_drift`) and reported.
5. **`.github/workflows/VOICE-PIPELINE-PARITY-SCANNER.yml`** runs the scan on every PR that touches the voice surface and posts a comment with the diff. **It does not block merges yet** — first we need 30 days of green runs to confirm the extractor is accurate. Then we promote it to a hard gate.

## Drift severity (planned promotion path)

| Phase | Trigger | Today | After 30 days green | Long-term |
|---|---|---|---|---|
| Foundation | drift detected | comment-only on PR | comment-only on PR | comment-only on PR |
| Soft gate | `arg_schema_mismatch` on any tool | comment | warning label on PR | block until resolved |
| Hard gate | `safety_critical: true` drift | comment | block until resolved | block until resolved |
| Audit | `undeclared` (impl has it, spec doesn't) | comment | auto-PR proposing spec update | auto-PR proposing spec update |

## Limits — what the scanner does NOT detect

- Semantic equivalence of two prompt templates (`"be concise"` vs `"keep replies short"`). Caught by the **system-instruction golden-file test**, not here.
- Runtime behaviour under load (do reconnect / watchdog timers actually fire). Caught by the **synthetic canary** in Phase 5.
- State-machine / tool-ordering equivalence. Caught by the **Feature Parity Acceptance Test**.
- LLM-side drift across model versions. Tracked via model pins in `agent_voice_configs`.

This scanner is a **strong drift detector and (eventual) merge gate**, not a correctness verifier. It pairs with the Feature Parity Acceptance Test and the Synthetic Canary as the three layers of drift defence.

## Running locally

```bash
cd voice-pipeline-spec
npm install
npm run scan      # extract both sides + diff against spec
npm run extract:ts
npm run extract:py
npm run diff
npm run validate-spec   # JSON Schema validation of spec.json itself
```

## Editing the spec

`spec.json` is updated by humans (drift caught by the scanner triggers an auto-PR labelled `parity-spec-update` for review). When adding a tool / topic / watchdog:

1. Add the entry to `spec.json` with a clear `owner_vtid` and `safety_critical` flag.
2. Implement on the Vertex side (or update the existing implementation).
3. Once the LiveKit side ships, implement there too. Until then, `implementations: ["vertex"]` is fine.

The scanner expects `spec.json` to remain valid JSON Schema 2020-12. Run `npm run validate-spec` before committing.

## Memory anchors

- `memory/feedback_navigator_surface_scoping.md` — `navigate_to_screen` cross-surface guard
- `memory/feedback_mobile_community_only.md` — mobile role coercion
- `memory/orb_apology_loop_fix_VTID_02637.md` — reconnect-bucket suppression
- `memory/agents_registry_shipped.md` — agents_registry table is where the LiveKit worker self-registers
- `memory/project_voice_self_healing_loop.md` — Sentinel quarantine integration target
