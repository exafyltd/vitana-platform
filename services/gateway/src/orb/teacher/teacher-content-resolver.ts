/**
 * VTID-03112 (T1) — Teacher Mode content resolver.
 *
 * When the wake-brief decider picks a Teacher candidate at session start,
 * the agent needs the manual content for that capability so it can teach
 * naturally — not just announce the capability name. This module fetches:
 *
 *   1. The system_capabilities row (display_name, description, manual_path).
 *   2. The knowledge_docs row at manual_path (markdown content).
 *   3. A short list of REMAINING eligible capabilities (the user's next
 *      pedagogical steps after this one) so the model can chain lessons
 *      without another round-trip.
 *
 * The output is the per-session payload the Teacher Mode prompt builder
 * reads. NO state machine, NO keyword rules — the resolver just gives the
 * LLM the raw teaching material + curriculum context. Judgment (when to
 * deliver intro, when to chain, when to end) lives in the prompt + the
 * LLM's interpretation of the user's transcribed reply.
 *
 * Fail-safe: any DB error degrades to a NULL TeacherModeContent; callers
 * fall back to the legacy Teacher line + no extended Teacher Mode. The
 * audio path is never blocked on this resolver.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  pickCapability,
  type CapabilityCatalogRow,
  type AwarenessLedgerRow,
} from '../../services/assistant-continuation/providers/teacher/feature-discovery-teacher';

export interface TeacherModeContent {
  /** The capability the wake-brief decider picked for this session. */
  active_capability_key: string;
  /** Display name (e.g. "The Five Pillars"). Spoken to the user. */
  active_display_name: string;
  /** One-sentence description from the catalog row. */
  active_description: string;
  /** Manual path (e.g. /manuals/maxina/00-concepts/five-pillars). Used
   *  by the optional tour navigation directive (T1c). */
  active_manual_path: string | null;
  /** Raw markdown content from knowledge_docs.content for the active
   *  capability's manual chapter. Truncated to MAX_MANUAL_CHARS so the
   *  injection into system_instruction stays bounded. May be empty
   *  string when the knowledge_docs row isn't found. */
  active_manual_content: string;
  /** VTID-03120: locked 3-4 sentence script in the user's language —
   *  hand-written in `system_capabilities.teacher_intro_*` so the
   *  Teacher prompt can use the deterministic "Say exactly:" pattern
   *  the wake-brief opener uses. Null when the row isn't seeded for
   *  this capability/lang; the prompt then falls back to manual-based
   *  generation. The fallback is intentional — capabilities without a
   *  seeded script still teach, they just rely on LLM judgment for
   *  length and phrasing. Operators add scripts to new capabilities
   *  via the system_capabilities table without a code deploy. */
  active_teacher_intro_script: string | null;
  /** Up to 5 remaining capabilities in pedagogical order so the LLM
   *  can chain to the next one without an extra fetch. Each entry has
   *  the display name + a one-line description (no manual content —
   *  the next chapter is fetched only when the LLM actually chains). */
  remaining_capabilities: Array<{
    capability_key: string;
    display_name: string;
    description: string;
    pedagogical_order: number | null;
  }>;
}

export interface TeacherContentResolverInputs {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
  activeCapabilityKey: string;
  /** VTID-03120: user's language. Picks teacher_intro_de or
   *  teacher_intro_en. Defaults to 'en' when absent. */
  lang?: string;
  nowIso?: string;
}

/** Cap for the manual content injected into system_instruction. Gemini's
 *  context window is generous but every char inflates latency + token
 *  cost. 6k chars ~ 1500-2000 tokens, enough for one full chapter. The
 *  LLM is told to summarize from the manual, not recite verbatim. */
const MAX_MANUAL_CHARS = 6000;

/** Number of remaining capabilities to expose to the LLM. Higher numbers
 *  let the LLM "skip ahead" if the user signals interest in a specific
 *  topic; lower numbers keep the curriculum tight. 5 balances both. */
const REMAINING_CAPABILITIES_LIMIT = 5;

/**
 * Fetch the Teacher Mode content payload for the given active capability.
 * Returns null on any failure or when the active capability has no manual
 * content — caller treats null as "Teacher Mode not available for this
 * session, fall back to one-shot offer".
 */
export async function resolveTeacherModeContent(
  inputs: TeacherContentResolverInputs,
): Promise<TeacherModeContent | null> {
  let catalog: CapabilityCatalogRow[] = [];
  let activeRow: CapabilityCatalogRow | null = null;
  // VTID-03120: keep the raw row (including the teacher_intro_* columns)
  // so we can resolve the locked script for the active capability + lang
  // BEFORE the pickCapability ranker discards everything except the
  // catalog-shape fields.
  let activeRawRow: Record<string, unknown> | null = null;
  try {
    const cap = await inputs.supabase
      .from('system_capabilities')
      .select('capability_key, display_name, description, manual_path, enabled, pedagogical_order, teacher_intro_de, teacher_intro_en')
      .eq('enabled', true);
    if (cap.error || !Array.isArray(cap.data)) {
      return null;
    }
    catalog = (cap.data as Array<Record<string, unknown>>).map((r) => ({
      capability_key: r.capability_key as string,
      display_name: r.display_name as string,
      description: r.description as string,
      manual_path: (r.manual_path as string | null) ?? null,
      enabled: r.enabled as boolean,
      pedagogical_order: (r.pedagogical_order as number | null) ?? null,
    }));
    activeRow = catalog.find((r) => r.capability_key === inputs.activeCapabilityKey) ?? null;
    activeRawRow =
      (cap.data as Array<Record<string, unknown>>).find(
        (r) => r.capability_key === inputs.activeCapabilityKey,
      ) ?? null;
  } catch {
    return null;
  }

  if (!activeRow) {
    // The active capability isn't in the catalog (or was disabled between
    // wake-brief pick and the resolver call) — Teacher Mode not available.
    return null;
  }

  // Fetch manual content for the active capability. The manual_path column
  // matches knowledge_docs.path (e.g. "/manuals/maxina/00-concepts/...").
  // Path-prefix style schemas may store paths without the leading slash;
  // try both forms.
  let manualContent = '';
  if (activeRow.manual_path) {
    try {
      const trimmed = activeRow.manual_path.trim();
      const variants = trimmed.startsWith('/')
        ? [trimmed, trimmed.replace(/^\//, '')]
        : [trimmed, '/' + trimmed];
      for (const p of variants) {
        const docs = await inputs.supabase
          .from('knowledge_docs')
          .select('content')
          .eq('path', p)
          .maybeSingle();
        if (!docs.error && docs.data) {
          const raw = (docs.data as { content?: string | null }).content;
          if (typeof raw === 'string' && raw.length > 0) {
            manualContent = raw.length > MAX_MANUAL_CHARS
              ? raw.slice(0, MAX_MANUAL_CHARS) + '\n\n[…truncated]'
              : raw;
            break;
          }
        }
      }
    } catch {
      // Manual fetch is best-effort — empty string is fine; the LLM
      // teaches from description alone if no manual content is found.
    }
  }

  // Compute remaining capabilities the LLM can chain to. Read the user's
  // ledger so the list excludes what's already tried / dismissed /
  // mastered. Uses the same pickCapability ranker as the Teacher provider
  // so the order matches the curriculum.
  let ledger: AwarenessLedgerRow[] = [];
  try {
    const led = await inputs.supabase
      .from('user_capability_awareness')
      .select('capability_key, awareness_state, dismiss_count, last_introduced_at')
      .eq('tenant_id', inputs.tenantId)
      .eq('user_id', inputs.userId);
    if (!led.error && Array.isArray(led.data)) {
      ledger = led.data as AwarenessLedgerRow[];
    }
  } catch {
    // Empty ledger = treat everything as 'unknown'.
  }

  // Build remaining list by iteratively picking the next eligible
  // capability AFTER excluding the active one. We model "exclude active"
  // by appending a synthetic ledger row that marks the active capability
  // as introduced just now — pickCapability's recent-introduction filter
  // takes it out of the pool. Then for each subsequent pick we extend
  // the same exclusion set.
  const remaining: TeacherModeContent['remaining_capabilities'] = [];
  const excludedKeys = new Set<string>([inputs.activeCapabilityKey]);
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  const augmentedLedger: AwarenessLedgerRow[] = [
    ...ledger,
    {
      capability_key: inputs.activeCapabilityKey,
      awareness_state: 'introduced',
      dismiss_count: 0,
      last_introduced_at: nowIso,
    },
  ];
  for (let i = 0; i < REMAINING_CAPABILITIES_LIMIT; i++) {
    const picked = pickCapability(catalog, augmentedLedger, nowIso);
    if (!picked) break;
    if (excludedKeys.has(picked.row.capability_key)) break;
    excludedKeys.add(picked.row.capability_key);
    remaining.push({
      capability_key: picked.row.capability_key,
      display_name: picked.row.display_name,
      description: picked.row.description,
      pedagogical_order: picked.row.pedagogical_order ?? null,
    });
    // Extend the exclusion for the next iteration so the same row doesn't
    // re-pick.
    augmentedLedger.push({
      capability_key: picked.row.capability_key,
      awareness_state: 'introduced',
      dismiss_count: 0,
      last_introduced_at: nowIso,
    });
  }

  // VTID-03120: resolve the locked intro script for the user's lang.
  // Falls back to the other language if the requested one is empty
  // (better to speak the locked script in the wrong language than to
  // collapse to manual-based generation and risk the 2-sentence issue).
  // Falls back to null only when BOTH language columns are empty —
  // then the prompt uses the manual-based fallback path.
  const lang = (inputs.lang || 'en').toLowerCase();
  let teacherIntroScript: string | null = null;
  if (activeRawRow) {
    const de = typeof activeRawRow.teacher_intro_de === 'string'
      ? activeRawRow.teacher_intro_de.trim()
      : '';
    const en = typeof activeRawRow.teacher_intro_en === 'string'
      ? activeRawRow.teacher_intro_en.trim()
      : '';
    if (lang.startsWith('de') && de) teacherIntroScript = de;
    else if (lang.startsWith('en') && en) teacherIntroScript = en;
    else if (en) teacherIntroScript = en;
    else if (de) teacherIntroScript = de;
  }

  return {
    active_capability_key: activeRow.capability_key,
    active_display_name: activeRow.display_name,
    active_description: activeRow.description,
    active_manual_path: activeRow.manual_path,
    active_manual_content: manualContent,
    active_teacher_intro_script: teacherIntroScript,
    remaining_capabilities: remaining,
  };
}
