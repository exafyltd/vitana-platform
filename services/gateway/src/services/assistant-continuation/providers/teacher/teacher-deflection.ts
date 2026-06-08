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
        ? `Let me introduce you to ${n} — a great next move. Let's take a quick look together.`
        : `Let me show you ${n} next — let's take a quick look together.`,
    fallback: (recType) =>
      recType === 'match'
        ? `Let me walk you through Vitanaland — I'll show you a good next step.`
        : `Let me show you a good next step in Vitanaland — let's take a look together.`,
  },
  de: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `Lass mich dir ${n} vorstellen — ein guter nächster Schritt. Lass uns gemeinsam einen Blick darauf werfen.`
        : `Lass mich dir als Nächstes ${n} zeigen — wir schauen es uns kurz gemeinsam an.`,
    fallback: (recType) =>
      recType === 'match'
        ? `Lass mich dich durch Vitanaland führen — ich zeige dir einen guten nächsten Schritt.`
        : `Lass mich dir einen guten nächsten Schritt in Vitanaland zeigen — wir schauen es uns gemeinsam an.`,
  },
  fr: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `Laisse-moi te présenter ${n} — une bonne prochaine étape. Regardons ça ensemble.`
        : `Laisse-moi te montrer ${n} — regardons ça rapidement ensemble.`,
    fallback: (recType) =>
      recType === 'match'
        ? `Laisse-moi te guider dans Vitanaland — je vais te montrer une bonne prochaine étape.`
        : `Laisse-moi te montrer une bonne prochaine étape dans Vitanaland — regardons ça ensemble.`,
  },
  es: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `Déjame presentarte ${n} — un buen siguiente paso. Vamos a verlo juntos.`
        : `Déjame mostrarte ${n} — le echamos un vistazo rápido juntos.`,
    fallback: (recType) =>
      recType === 'match'
        ? `Déjame guiarte por Vitanaland — te muestro un buen siguiente paso.`
        : `Déjame mostrarte un buen siguiente paso en Vitanaland — lo vemos juntos.`,
  },
  sr: {
    withCapability: (n, recType) =>
      recType === 'match'
        ? `Да ти представим ${n} — добар следећи корак. Хајде да погледамо заједно.`
        : `Да ти покажем ${n} — хајде да брзо погледамо заједно.`,
    fallback: (recType) =>
      recType === 'match'
        ? `Да те проведем кроз Vitanaland — показаћу ти добар следећи корак.`
        : `Да ти покажем добар следећи корак у Vitanaland-у — хајде да погледамо заједно.`,
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
