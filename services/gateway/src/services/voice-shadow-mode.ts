/**
 * Voice Shadow Mode (VTID-01964, PR #7)
 *
 * Shadow Mode runs the entire adapter pipeline (classifier, Sentinel gate,
 * Spec Memory Gate, dedupe) but DOES NOT POST to /api/v1/self-healing/report.
 * Every decision the adapter would have made is logged to
 * voice_healing_shadow_log so PR #8's dashboard can compute the comparison
 * view ops needs before flipping mode=live.
 *
 * This module exposes:
 *   - appendShadowLog(record): append a decision row.
 *   - setMode(mode, actorVtid): flip system_config.voice_self_healing_mode.
 *
 * The mode flip itself is idempotent — POSTing twice to set 'shadow' is safe.
 * Ops uses this via POST /api/v1/voice-lab/healing/mode (PR #7 also adds
 * that route).
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GATEWAY_REVISION =
  process.env.K_REVISION || process.env.BUILD_INFO || 'unknown';

export type SelfHealingMode = 'off' | 'shadow' | 'live';

export interface ShadowLogRecord {
  mode: SelfHealingMode;
  action: string;
  class?: string | null;
  normalized_signature?: string | null;
  spec_hash?: string | null;
  detail?: string | null;
  session_id?: string | null;
  tenant_scope?: string | null;
}

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Append a decision row to voice_healing_shadow_log. Best-effort; never
 * throws. Called by the adapter at the end of every dispatch attempt
 * (regardless of action) when mode != 'off'.
 */
export async function appendShadowLog(record: ShadowLogRecord): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/voice_healing_shadow_log`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        mode: record.mode,
        action: record.action,
        class: record.class ?? null,
        normalized_signature: record.normalized_signature ?? null,
        spec_hash: record.spec_hash ?? null,
        detail: record.detail ?? null,
        session_id: record.session_id ?? null,
        tenant_scope: record.tenant_scope ?? null,
        gateway_revision: GATEWAY_REVISION,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SetModeResult {
  ok: boolean;
  previous: SelfHealingMode | null;
  new: SelfHealingMode;
  error?: string;
}

const MODE_KEY = 'voice_self_healing_mode';

async function readMode(): Promise<SelfHealingMode | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/system_config?key=eq.${MODE_KEY}&select=value&limit=1`,
      { headers: supabaseHeaders() },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ value?: string }>;
    const v = rows[0]?.value;
    if (v === 'off' || v === 'shadow' || v === 'live') return v;
    return null;
  } catch {
    return null;
  }
}

/**
 * Flip system_config.voice_self_healing_mode. Idempotent — setting the
 * current value is a no-op success. Emits an OASIS event for audit.
 */
export async function setMode(
  next: SelfHealingMode,
  actorVtid: string,
): Promise<SetModeResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, previous: null, new: next, error: 'no_supabase' };
  }
  if (next !== 'off' && next !== 'shadow' && next !== 'live') {
    return { ok: false, previous: null, new: next, error: 'invalid_mode' };
  }

  const previous = await readMode();
  if (previous === next) {
    return { ok: true, previous, new: next };
  }

  // Upsert into system_config — assume the canonical schema is
  // system_config(key TEXT PK, value TEXT, updated_at TIMESTAMPTZ).
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/system_config?on_conflict=key`,
      {
        method: 'POST',
        headers: {
          ...supabaseHeaders(),
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          key: MODE_KEY,
          value: next,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        previous,
        new: next,
        error: `upsert_${res.status}_${text.slice(0, 80)}`,
      };
    }
  } catch (err: any) {
    return { ok: false, previous, new: next, error: `upsert_fetch: ${err?.message ?? ''}` };
  }

  try {
    await emitOasisEvent({
      vtid: actorVtid,
      type: 'voice.healing.dispatched',
      source: 'voice-shadow-mode',
      status: 'info',
      message: `Voice self-healing mode flipped: ${previous ?? '(unset)'} → ${next}`,
      payload: {
        previous_mode: previous,
        new_mode: next,
        actor_vtid: actorVtid,
      },
    });
  } catch {
    /* best-effort */
  }

  return { ok: true, previous, new: next };
}
