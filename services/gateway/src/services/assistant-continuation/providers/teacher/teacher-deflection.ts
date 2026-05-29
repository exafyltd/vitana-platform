/**
 * VTID-03110 — "I have no personalized recommendations" must NEVER be the
 * spoken answer.
 *
 * For the community education phase, Vitana is the Teacher of the system
 * — there are 25+ capabilities seeded in `system_capabilities`, each with
 * a manual chapter in `knowledge_docs`. Even when the recommendation
 * queries return zero rows (no fresh community match, no daily ranked
 * suggestion), there is ALWAYS something the Teacher can introduce.
 *
 * This module produces a context-aware tool-result string for the empty
 * state of `get_recommendations` (both Vertex's voice tool handler in
 * `routes/orb-live.ts` and the text-mode tool in `services/gemini-
 * operator.ts`). It picks the next eligible capability using the same
 * `pickCapability` ranker the Teacher provider uses, and returns a
 * localized teaching-offer sentence Gemini will speak instead of the
 * dismissive "no recommendations" line.
 *
 * Behavior:
 *   - When pickCapability returns a row → "I don't have a specific
 *     community match for you right now, but there's plenty to learn
 *     in Vitanaland. Want me to introduce you to <display_name>?"
 *   - When pickCapability returns null (all capabilities exhausted /
 *     catalog empty / DB error) → fall back to a generic "lots to
 *     explore — what would you like to dive into?" line. Still never
 *     "no recommendations available".
 *
 * No hardcoded sequence. The capability suggested is whichever row the
 * `pickCapability` sort selects (driven by `pedagogical_order` from the
 * DB column).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  pickCapability,
  type CapabilityCatalogRow,
  type AwarenessLedgerRow,
} from './feature-discovery-teacher';

export interface TeacherDeflectionInputs {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
  /** ISO 639-1 lang code. Falls back to 'en'. */
  lang?: string;
  /** Which recommendation type was empty. Lets the deflection prefix
   *  acknowledge what the user asked for ('match', 'community', 'all'). */
  recType?: string;
  /** Server-side now, injectable for tests. */
  nowIso?: string;
}

/**
 * Phrasings keyed by lang. Each entry has TWO clauses:
 *   - `withCapability(displayName, recType)` — fires when pickCapability
 *     returned a row. Mentions both the (lack of) recommendation AND
 *     the teaching offer.
 *   - `fallback(recType)` — when no capability is available either.
 *     Should NEVER include the phrase "no personalized recommendations"
 *     or any equivalent — the whole point of this module.
 *
 * The phrasings are intentionally short + warm. Gemini paraphrases
 * tool-result strings, so brevity helps keep paraphrasing close to
 * intent.
 */
type Phrasings = {
  withCapability: (displayName: string, recType: string) => string;
  fallback: (recType: string) => string;
};

const PHRASINGS: Record<string, Phrasings> = {
  en: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `I don't have a fresh community match lined up for you right now, but there's plenty in Vitanaland I can show you. Want me to introduce you to ${n}?`
        : `I don't have a specific recommendation queued up right now, but there's plenty to learn in Vitanaland. Want me to introduce you to ${n}?`,
    fallback: (recType) =>
      recType === 'match'
        ? `No fresh community match is queued up at the moment, but I can walk you through anything in Vitanaland. What would you like to explore?`
        : `Nothing specific is queued up at the moment, but Vitanaland has lots to learn. What would you like to dive into?`,
  },
  de: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `Aktuell habe ich kein frisches Community-Match für dich, aber in Vitanaland gibt es viel, was ich dir zeigen kann. Magst du, dass ich dir ${n} vorstelle?`
        : `Aktuell ist nichts Spezifisches für dich vorgemerkt, aber in Vitanaland gibt es viel zu lernen. Magst du, dass ich dir ${n} vorstelle?`,
    fallback: (recType) =>
      recType === 'match'
        ? `Im Moment ist kein neues Community-Match vorgemerkt, aber ich kann dich durch alles in Vitanaland führen. Was möchtest du entdecken?`
        : `Im Moment ist nichts Spezifisches vorgemerkt, aber in Vitanaland gibt es viel zu lernen. Wo möchtest du anfangen?`,
  },
  fr: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `Je n'ai pas de match communautaire frais pour toi en ce moment, mais Vitanaland a beaucoup à offrir. Veux-tu que je te présente ${n} ?`
        : `Je n'ai pas de recommandation spécifique en file d'attente, mais il y a beaucoup à apprendre dans Vitanaland. Veux-tu que je te présente ${n} ?`,
    fallback: (recType) =>
      recType === 'match'
        ? `Aucun match communautaire frais pour le moment, mais je peux te guider à travers tout Vitanaland. Que veux-tu explorer ?`
        : `Rien de spécifique en file en ce moment, mais Vitanaland a beaucoup à apprendre. Par où veux-tu commencer ?`,
  },
  es: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `Ahora mismo no tengo un match nuevo de la comunidad para ti, pero hay mucho que puedo mostrarte en Vitanaland. ¿Te presento ${n}?`
        : `No tengo una recomendación específica en cola ahora mismo, pero hay mucho que aprender en Vitanaland. ¿Te presento ${n}?`,
    fallback: (recType) =>
      recType === 'match'
        ? `No hay un match nuevo de la comunidad ahora mismo, pero puedo guiarte por todo Vitanaland. ¿Qué te gustaría explorar?`
        : `Nada específico en cola ahora mismo, pero hay mucho que aprender en Vitanaland. ¿Por dónde empezamos?`,
  },
  sr: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `Тренутно немам свежи community match за тебе, али у Vitanaland-у имам много шта да ти покажем. Желиш ли да ти представим ${n}?`
        : `Тренутно немам специфичну препоруку, али у Vitanaland-у има много да се учи. Желиш ли да ти представим ${n}?`,
    fallback: (recType) =>
      recType === 'match'
        ? `Тренутно нема новог community match-а, али могу да те водим кроз било шта у Vitanaland-у. Шта желиш да истражиш?`
        : `Тренутно ништа специфично није на чекању, али Vitanaland има много да научиш. Где желиш да почнемо?`,
  },
};

function langPhrasings(lang: string | undefined): Phrasings {
  const k = (lang || 'en').toLowerCase();
  return PHRASINGS[k] || PHRASINGS.en;
}

/**
 * Build the deflection string. Returns a Promise — DB-side fetches for
 * the catalog + ledger. Failures degrade to the fallback phrasing
 * (still never says "no recommendations").
 */
export async function buildTeacherDeflectionForEmptyRecommendations(
  inputs: TeacherDeflectionInputs,
): Promise<string> {
  const lang = (inputs.lang || 'en').toLowerCase();
  const recType = inputs.recType || 'all';
  const phr = langPhrasings(lang);

  let catalog: CapabilityCatalogRow[] = [];
  let ledger: AwarenessLedgerRow[] = [];
  try {
    const cap = await inputs.supabase
      .from('system_capabilities')
      .select('capability_key, display_name, description, manual_path, enabled, pedagogical_order')
      .eq('enabled', true);
    if (!cap.error && Array.isArray(cap.data)) {
      catalog = cap.data as CapabilityCatalogRow[];
    }
    const led = await inputs.supabase
      .from('user_capability_awareness')
      .select('capability_key, awareness_state, dismiss_count, last_introduced_at')
      .eq('tenant_id', inputs.tenantId)
      .eq('user_id', inputs.userId);
    if (!led.error && Array.isArray(led.data)) {
      ledger = led.data as AwarenessLedgerRow[];
    }
  } catch {
    // Fall through to fallback phrasing — never throw on this path.
  }

  if (catalog.length === 0) {
    return phr.fallback(recType);
  }

  const nowIso = inputs.nowIso ?? new Date().toISOString();
  const picked = pickCapability(catalog, ledger, nowIso);
  if (!picked) {
    return phr.fallback(recType);
  }
  return phr.withCapability(picked.row.display_name, recType);
}
