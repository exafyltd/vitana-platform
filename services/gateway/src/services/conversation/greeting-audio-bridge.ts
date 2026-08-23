/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: greeting AUDIO bridge.
 *
 * The real (context-heavy) greeting takes 5-8+ seconds to reach first audio
 * on both Vertex and Nova today (see voice.latency.measured — the model must
 * prefill the full system instruction + tool catalog before it can speak).
 * That's a wall of silence the user has no reason to expect after tapping
 * Connect & Talk.
 *
 * This module builds a SHORT, near-instant, TTS-synthesized phrase — date +
 * a rotating motivational line + a transition into the real greeting — that
 * plays while the real upstream is still connecting/prefilling. It is pure
 * text generation only; synthesis and SSE wiring live in the caller
 * (orb-live.ts), which also owns the feature-flag gate.
 */

import { tt, GATEWAY_LOCALES, type GatewayLocale } from '../../i18n/catalog';

const LINE_KEYS = [
  'orb.greeting_bridge.line_1',
  'orb.greeting_bridge.line_2',
  'orb.greeting_bridge.line_3',
  'orb.greeting_bridge.line_4',
  'orb.greeting_bridge.line_5',
] as const;

export type GreetingBridgeTimeOfDay = 'morning' | 'afternoon' | 'evening';

/** Local-hour → greeting bucket. Mirrors the existing priority.greeting.* split. */
export function resolveGreetingBridgeTimeOfDay(localHour: number): GreetingBridgeTimeOfDay {
  if (localHour < 12) return 'morning';
  if (localHour < 18) return 'afternoon';
  return 'evening';
}

/**
 * Deterministic day-of-year rotation — no DB state needed, and every session
 * on the same calendar day gets the same line (avoids an obviously-random
 * feel across quick reconnects within one sitting).
 */
export function pickGreetingBridgeLineKey(dayOfYear: number): (typeof LINE_KEYS)[number] {
  const idx = ((dayOfYear % LINE_KEYS.length) + LINE_KEYS.length) % LINE_KEYS.length;
  return LINE_KEYS[idx];
}

export interface GreetingBridgeTextOptions {
  lang: string | GatewayLocale | null | undefined;
  /** Current instant — pass explicitly so callers stay testable (no Date.now() inside). */
  now: Date;
  /** IANA timezone for local-hour + local-date resolution. Falls back to UTC. */
  timezone?: string | null;
}

/**
 * Build the full spoken bridge phrase: "{Good morning/afternoon/evening}!
 * Today is {date}. {motivational line} {transition into the real greeting}".
 * Pure — safe to unit test without a TTS client or a live session.
 */
export function buildGreetingBridgeText(options: GreetingBridgeTextOptions): string {
  const tz = options.timezone && options.timezone.trim().length > 0 ? options.timezone : 'UTC';
  // Normalize ONCE and use this everywhere below (both Intl formatting and
  // every tt() call) — tt()'s own unknown-locale fallback is 'de' (the
  // catalog default), which differs from ours ('en'), so passing the raw
  // unnormalized lang through would mix a German-fallback template with an
  // English-fallback date, e.g. "Guten Morgen! ... July 26. ...".
  const locale = normalizeToBcp47(options.lang);

  let localHour: number;
  let dateText: string;
  try {
    localHour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(options.now),
    );
  } catch {
    localHour = options.now.getUTCHours();
  }
  try {
    dateText = new Intl.DateTimeFormat(locale, { timeZone: tz, month: 'long', day: 'numeric' }).format(options.now);
  } catch {
    dateText = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(options.now);
  }

  const startOfYearUtc = Date.UTC(options.now.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((options.now.getTime() - startOfYearUtc) / 86_400_000);
  const lineKey = pickGreetingBridgeLineKey(dayOfYear);
  const line = tt(lineKey, locale);
  const transition = tt('orb.greeting_bridge.transition', locale);

  const timeOfDay = resolveGreetingBridgeTimeOfDay(localHour);
  const openerKey =
    timeOfDay === 'morning'
      ? 'orb.greeting_bridge.morning'
      : timeOfDay === 'afternoon'
        ? 'orb.greeting_bridge.afternoon'
        : 'orb.greeting_bridge.evening';

  const opener = tt(openerKey, locale, { date: dateText, line });
  return `${opener} ${transition}`;
}

/**
 * Mirrors `normalizeLocale()` in i18n/catalog.ts EXACTLY (same supported set,
 * same 'de' fallback for anything else) so the Intl-formatted date and the
 * tt()-rendered template text are always in the SAME language.
 *
 * VTID-03559: this used to hardcode a 4-locale set because the gateway i18n
 * catalog genuinely had no fr/pt/ru/pl entries — normalizing to 'de' kept the
 * date and the sentence in one language rather than gluing a French date to a
 * German sentence. VTID-03509 added those catalogs, so the premise is gone and
 * the hardcoded copy became the bug: an fr/pt/ru/pl session heard the entire
 * greeting bridge in German, spoken in their target-language voice. Derived
 * from GATEWAY_LOCALES now, so a ninth locale needs no edit here.
 */
function normalizeToBcp47(lang: string | GatewayLocale | null | undefined): string {
  const base = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0];
  const supported = new Set<string>(GATEWAY_LOCALES);
  return supported.has(base) ? base : 'de';
}
