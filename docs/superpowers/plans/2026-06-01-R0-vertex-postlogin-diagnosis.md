# R0 — Vertex Post-Login "No Audio" Diagnosis

**Phase**: Reconciliation R0 (strict blocker).
**Date**: 2026-06-01.
**Mode**: code-path + shipped-evidence diagnosis (no code change — R0 is diagnosis-only).
**Basis**: `claude/zealous-darwin-sAUk8` synced to `origin/main`.

## Verdict

**The "Vertex broken post-login" report is a DATA-SIZE-driven silent setup failure, not a generic Vertex outage.** The post-login Vertex Live `system_instruction` has **no total-size guard** before it is sent. For users with enough accumulated state, the aggregate instruction exceeds the **~32 KB Vertex Live API setup budget** (a limit the codebase itself documents). Vertex then closes the WebSocket during the handshake (or never returns `setup_complete`), the client rejects/ times out, and the user hears **silence** — with no diagnostic that says "instruction too large."

The **LiveKit canary allowlist masked it**: non-allowlisted users default to Vertex; adding a heavy user (dragan1) to the allowlist routes them to **LiveKit**, which does not hit this Vertex setup-budget path — so the user "starts working" and the Vertex defect stays invisible. This is exactly the asymmetry the 2026-05-31 audit (§E) flagged.

Phase A (#2403, `BOOTSTRAP-orb-bootstrap-cap`) already shipped a **partial** mitigation — it caps the *bootstrap-context contribution* — but **not the total payload**, so the failure can still occur via the un-capped sections.

## Evidence (file:line)

### 1. Transport: non-allowlisted → Vertex (the masking mechanism)
`services/gateway/src/orb/live/upstream/active-provider-resolver.ts:115-165` — when global provider is `vertex`, returns `effectiveProvider:'vertex'` (`default_vertex`); a user not in the canary `allowedUsers`/`allowedTenants` returns `vertex` with reason `canary_not_allowlisted`. Allowlisting a user routes them to LiveKit instead → masks any Vertex-specific defect.

### 2. Vertex setup send — no size check
- Envelope built in `buildOrbVertexSetupEnvelope()` `services/gateway/src/routes/orb-live.ts:5781+`; `system_instruction.parts[].text` is either `personaSystemOverride` or `buildLiveSystemInstruction(...)` with all context blocks concatenated (`orb-live.ts:5855-6001`).
- Sent in `vertex-live-client.ts:200`: `ws.send(JSON.stringify(envelope));` — **no `byteLength` / length check anywhere before this call** (confirmed: the only `32768` in the path is a PCM audio clamp at `orb-live.ts:1417`).

### 3. Size guards exist only on sub-components, not the total
- Bootstrap memory formatting capped at 8 KB: `orb-live.ts:1441-1452` (`LIVE_CONTEXT_CONFIG.MAX_CONTEXT_CHARS = 8000`), applied `:1979-1981`.
- Bootstrap *contribution* capped at 12 KB: `orb/live/instruction/bootstrap-cap.ts:26` (`BOOTSTRAP_CONTEXT_MAX_CHARS = 12_000`), applied `live-system-instruction.ts:805-819`.
- **No cap on the aggregate** `system_instruction`, which also concatenates (all un-capped): `personaSystemOverride`, `clientContext`, `specialistContextSection`, `lastTranscriptSection`, `onboardingCohortBlock`, `swapBackWelcomeBlock`, `wakeBriefOverrideBlock`, `teacherModeContent`, plus the static scaffold (navigator policy, temporal context, greeting policy, tool catalog) and conversation history (~4 KB cap, `live-system-instruction.ts:826`).

### 4. Setup-failure handling — opaque, no size classification
`services/gateway/src/orb/live/upstream/vertex-live-client.ts`:
- `:200` setup sent without validation.
- `:259-265` `ws.on('close')` during handshake → `reject(new Error('Live API closed during handshake (code=' + code + ')'))`. The close **code is not classified** — a `1009` (message-too-big) / `1007` looks identical to any other handshake close.
- `:188-189` 15 s connect timeout (`orb-live.ts:5767-5773`, `connectTimeoutMs:15000` at `:6053`) → `reject('Live API connection timeout')` if Vertex neither completes setup nor closes.
- Net: either path ends in **silence** for the user with **no "instruction exceeded budget" diagnostic**.

### 5. The ~32 KB budget is already known in-code
`orb/live/instruction/bootstrap-cap.ts:5,22` and `live-system-instruction.ts:801-803` both explicitly document the **~32 KB Vertex Live setup budget** and that overflow "silently fails setup → no TTS frames." The hypothesis is the codebase's own stated failure mode — only the mitigation is incomplete.

## Recommended fix (owner: ORB-recovery Phase A extension — this program's Lane MEM, NOT a new phase)

1. **Total-payload guard before send.** In `buildOrbVertexSetupEnvelope()` (just before returning the envelope) or immediately before `ws.send` (`vertex-live-client.ts:200`), measure `Buffer.byteLength(systemInstructionText, 'utf8')`. If over a safe budget (recommend **30 KB**, leaving headroom under 32 KB), trim in priority order — bootstrap context first, then conversation history, then specialist/teacher blocks — and emit a structured `[voice.instruction.budget_overflow]` log with total bytes + per-section sizes. This extends the existing Phase A `bootstrap-cap` from sub-component to aggregate.
2. **Classify setup-time close codes.** In `vertex-live-client.ts` `ws.on('close')` during handshake, detect `1009`/`1007` and emit `vertex.live.setup.too_large` (vs. a generic handshake close) so the failure is observable in logs, not opaque.
3. **Parity note.** Verify the same total-guard logic is referenced by the LiveKit path or explicitly documented as not-needed (LiveKit injects differently); record in the PR's "Vertex parity ✓ / LiveKit parity ✓" line.

## Live verification still required (OUT-OF-SANDBOX — logged to pending-human-actions)

This diagnosis is from code + shipped evidence; the following confirm it on prod and are out-of-sandbox here:
1. Open ORB as synthetic user `a27552a3-0257-4305-8ed0-351a80fd3701` (NOT on the LiveKit allowlist) → confirm silence on Vertex, and capture whether the gateway logs `Live API closed during handshake (code=1009)` or `Live API connection timeout`.
2. Measure the actual aggregate `system_instruction` byte size for dragan1 (heavy) vs dragan3 (clean) via a dev route or a one-line log of `Buffer.byteLength` at the send site — confirm dragan1 crosses ~32 KB.
3. `gcloud` log pull (needs reauth) filtered to `Live API closed during handshake` / `Live API connection timeout` over the last 14 days to quantify affected sessions.

If (2) shows dragan1 is **under** 32 KB yet still silent, the size hypothesis is wrong and the diagnosis must reopen toward a generic Vertex setup/auth issue — but all current code evidence points to the size path.
