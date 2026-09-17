/**
 * VTID-04000 — narrow, explicit, time-boxed exception to "Vertex is not a
 * destination" (VTID-03723, `upstream-provider-selector.ts`). See
 * CLAUDE.md §2e-vertex-serbian-bridge.
 *
 * Serbian has no Nova Sonic voice and no Polly voice; the Transcribe ->
 * Bedrock -> Fish cascade built to cover it (VTID-03970/03987) measured no
 * meaningful latency win from tuning Fish's own request shape (VTID-03998
 * — Fish's synthesis throughput is ~50-60 chars/sec regardless of its
 * `latency` mode, so a realistic ~500-char reply costs ~9-10s in TTS alone,
 * on top of the cascade's own LLM-completion latency; combined, that is
 * what was blowing past the 30s `greeting_timeout` stall watchdog for
 * pre-login `sr` sessions). The platform owner opened a NEW, dedicated GCP
 * project (never `lovable-vitana-vers1`, which stays permanently
 * decommissioned) with a 90-day free-credit window and asked to revive the
 * Vertex Live API client for Serbian specifically — it was never deleted,
 * only made structurally unreachable by the selector, and Gemini Live
 * natively speaks Serbian in one hop (no Transcribe/Bedrock/Fish relay, so
 * none of the cascade's turn-shaping cost applies).
 *
 * Deliberately narrow: this must NEVER become a second silent path back to
 * Vertex for other languages or sessions — that silent-fallback shape is
 * exactly what caused the original Gemini cost incident (CLAUDE.md §2b)
 * and the VTID-03723 pl/pt English-speaking incident
 * `upstream-provider-selector.ts`'s own header documents. Both gates below
 * are required, and BOTH must be explicit — there is no case where one
 * alone is enough:
 *   - `isVertexSerbianBridgeEnabled()` — the operator's own on/off switch,
 *     default OFF (same activation-gate convention as
 *     `isCascadeEnabled()`/`NOVA_SONIC_GLOBAL_ENABLED`: an exact string
 *     `'true'`, so a typo resolves to off, never truthy).
 *   - `isVertexSerbianBridgeLanguage(lang)` — true ONLY for `sr` (any
 *     region/script suffix, e.g. `sr-RS`, `sr_Latn_RS`). Never widened to
 *     a language list — one language, one narrow bridge, easy to delete
 *     outright once the 90-day credit window ends or the cascade's own
 *     turn-shaping gets fixed instead.
 */

export function isVertexSerbianBridgeEnabled(): boolean {
  return (process.env.VERTEX_SERBIAN_BRIDGE_ENABLED || '').trim() === 'true';
}

export function isVertexSerbianBridgeLanguage(lang: string | null | undefined): boolean {
  const normalized = (lang || '').toLowerCase().split(/[-_]/)[0];
  return normalized === 'sr';
}
