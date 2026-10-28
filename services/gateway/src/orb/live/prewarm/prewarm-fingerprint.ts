/**
 * VTID-04554 — prewarm parity for the Nova Sonic warm start (VTID-03779).
 *
 * The login-time prewarm opens a real Nova stream before the member taps the
 * ORB. Until now that stream was built with a reduced instruction: no personal
 * context, no instruction budget, an untrimmed tool catalog, and the role from
 * `user_tenants.active_role` only — and the session claimed it without
 * comparing. A claimed stream therefore opened the conversation with no memory
 * of the member, a quality regression paid for a latency win.
 *
 * With `ORB_PREWARM_FULL_CONTEXT_ENABLED=true` (exact string; default OFF,
 * which keeps today's behaviour byte for byte):
 *
 *   1. the prewarm builds its envelope through the SAME function the session
 *      uses (`assembleOrbSetupEnvelope` in routes/orb-live.ts) over a shadow of
 *      the session it expects, and records a fingerprint of what it sent;
 *   2. the session builds its own envelope exactly as a cold start does, then
 *      claims the pooled stream ONLY when the fingerprints match. Anything
 *      else discards the prewarm and connects cold.
 *
 * The fingerprint covers what is baked into the Nova stream at connect time
 * and nothing else: the final (Nova-sanitized) system instruction, the tool
 * declarations, the voice, the language, the model, the VAD silence setting
 * and the response modality. The greeting directive is NOT part of it — it is
 * sent later as a text turn on whichever stream the session ends up on. Note
 * the wake-brief override block (`session.wakeBriefOverrideBlock`) IS part of
 * the system instruction (orb-live.ts appends it to the context passed to
 * `buildLiveSystemInstruction`), so a session with a wake-brief winner cannot
 * match a prewarm built before that winner was chosen, and goes cold.
 *
 * Pure module: no I/O, no env reads except the flag reader.
 */

import { createHash } from 'crypto';

export const PREWARM_FULL_CONTEXT_FLAG = 'ORB_PREWARM_FULL_CONTEXT_ENABLED';

/** Exact string `'true'` enables; anything else (unset, a typo) is OFF. */
export function isPrewarmFullContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PREWARM_FULL_CONTEXT_FLAG] === 'true';
}

export interface NovaStreamShape {
  /** The system instruction exactly as sent to Nova (after sanitization). */
  systemInstruction: string;
  /** The tool groups exactly as sent to Nova. */
  tools: Array<Record<string, unknown>>;
  voiceId: string;
  lang: string;
  model: string;
  vadSilenceMs: number;
  responseModalities: string[];
}

/** Stable JSON: object keys sorted at every level, so key order never changes the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The ENVIRONMENT block renders `Current UTC time: <ISO, ms>` and
 * `Local time: <weekday part, HH:MM>` at the moment the envelope is built
 * (orb/live/instruction/client-context-format.ts), so two builds of the same
 * session context minutes — or milliseconds — apart are never identical. This
 * masks those two lines. DIAGNOSTIC ONLY (`differs_only_in_render_time` on
 * `nova_prewarm_missed`): it says how often a prewarm would have matched but
 * for the clock. It is never used to decide a claim — a claimed stream must
 * carry exactly what the session would have sent.
 */
export function maskRenderTimeLines(instruction: string): string {
  return instruction
    .replace(/^Current UTC time: .*$/gm, 'Current UTC time: <render-time>')
    .replace(/^Local time: .*$/gm, 'Local time: <render-time>');
}

/** Declared tool names in catalog order — kept on the diag, never used to decide. */
export function toolNamesOf(tools: Array<Record<string, unknown>>): string[] {
  const names: string[] = [];
  for (const group of tools || []) {
    const decls = (group as { function_declarations?: Array<{ name?: unknown }> }).function_declarations;
    if (Array.isArray(decls)) {
      for (const d of decls) if (typeof d?.name === 'string') names.push(d.name);
    } else if (group && typeof group === 'object') {
      names.push(`<${Object.keys(group).sort().join('+')}>`);
    }
  }
  return names;
}

/**
 * sha256 over everything the stream carries from connect. The tool part is
 * the full declarations (names, descriptions, schemas), not names only: two
 * catalogs with the same names but a different description are different
 * streams, and a claim must never hand a session a catalog it would not have
 * sent itself.
 */
export function computeNovaStreamFingerprint(
  shape: NovaStreamShape,
  opts: { ignoreRenderTime?: boolean } = {},
): string {
  const h = createHash('sha256');
  h.update('instruction\0');
  h.update(opts.ignoreRenderTime ? maskRenderTimeLines(shape.systemInstruction || '') : (shape.systemInstruction || ''));
  h.update('\0tools\0');
  h.update(stableStringify(shape.tools || []));
  h.update('\0voice\0');
  h.update(shape.voiceId || '');
  h.update('\0lang\0');
  h.update(shape.lang || '');
  h.update('\0model\0');
  h.update(shape.model || '');
  h.update('\0vad\0');
  h.update(String(shape.vadSilenceMs ?? ''));
  h.update('\0modalities\0');
  h.update((shape.responseModalities || []).join(','));
  return h.digest('hex');
}

export type PrewarmMissReason =
  | 'fingerprint_mismatch'
  | 'language_mismatch'
  | 'guided_topic'
  | 'no_fingerprint';

export type PrewarmClaimDecision =
  | { claim: true }
  | { claim: false; reason: PrewarmMissReason; discard: boolean };

/**
 * Whether a pooled prewarm may serve this session. Never claims for a
 * guided-topic session (its lesson context is built at start; the pooled
 * stream is left for a later ordinary open, `discard:false`), a different
 * language, a prewarm with no fingerprint (built with the flag off), or any
 * fingerprint difference. `discard:true` means the pooled stream can never
 * serve this user's session and should be closed.
 */
export function decidePrewarmClaim(input: {
  prewarm: { lang: string; fingerprint?: string | null };
  session: { lang: string; fingerprint: string; isGuidedTopic: boolean };
}): PrewarmClaimDecision {
  if (input.session.isGuidedTopic) return { claim: false, reason: 'guided_topic', discard: false };
  if ((input.prewarm.lang || '') !== (input.session.lang || '')) {
    return { claim: false, reason: 'language_mismatch', discard: true };
  }
  if (!input.prewarm.fingerprint) return { claim: false, reason: 'no_fingerprint', discard: true };
  if (input.prewarm.fingerprint !== input.session.fingerprint) {
    return { claim: false, reason: 'fingerprint_mismatch', discard: true };
  }
  return { claim: true };
}
