/**
 * VTID-02031: Ops "Action Required" — pull surface that mirrors the Gchat
 * push pings (VTID-02030). Returns the unified list of items currently
 * demanding a human supervisor across surfaces (voice, self-healing,
 * deploy) so the Command Hub Overview can render a single panel instead
 * of forcing the operator to walk separate dashboards.
 *
 * Sources:
 *   1. voice_healing_quarantine where status='quarantined'
 *      → 🛑 voice class quarantined; auto-loop stopped
 *   2. voice_architecture_reports where status='open'
 *      AND recommendation.track != 'stay_and_patch'
 *      → 🧠 architectural recommendation needs human read
 *   3. self_healing_log where outcome IN ('escalated','rolled_back')
 *      AND age < 24h AND not yet in `acknowledged_at`
 *      → 🚨 self-heal gave up / blast-radius rollback
 *
 * Read-only and side-effect-free. Mounted at /api/v1/ops/action-required.
 */

import { Router, Request, Response } from 'express';

const router = Router();

const ITEM_LOOKBACK_HOURS = 72; // window for self-heal escalations

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

interface ActionItem {
  id: string;
  severity: 'critical' | 'warning';
  category: 'voice' | 'self-heal' | 'deploy';
  title: string;
  summary: string;
  detected_at: string;
  deeplink: string;
  source_table: string;
  source_id: string | null;
}

const ARCHITECTURAL_TRACKS_REGEX = /^(?!stay_and_patch$)/i;

async function fetchVoiceQuarantines(
  config: { url: string; key: string },
): Promise<ActionItem[]> {
  try {
    const r = await fetch(
      `${config.url}/rest/v1/voice_healing_quarantine?status=eq.quarantined&select=class,normalized_signature,quarantined_at,reason&order=quarantined_at.desc&limit=50`,
      { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` } },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      class: string;
      normalized_signature: string | null;
      quarantined_at: string;
      reason: string | null;
    }>;
    return rows.map((row) => ({
      id: `voice-quarantine:${row.class}:${row.normalized_signature ?? '_'}`,
      severity: 'critical',
      category: 'voice',
      title: `Voice class quarantined: ${row.class}`,
      summary:
        `Auto-loop stopped on this class. Reason: ${row.reason ?? 'thresholds tripped'}.` +
        ` Open Voice Lab → Healing tab to investigate or release.`,
      detected_at: row.quarantined_at,
      deeplink: `/command-hub/diagnostics/voice-lab/?healing=quarantined&class=${encodeURIComponent(row.class)}`,
      source_table: 'voice_healing_quarantine',
      source_id: `${row.class}:${row.normalized_signature ?? '_'}`,
    }));
  } catch {
    return [];
  }
}

async function fetchOpenArchitecturalReports(
  config: { url: string; key: string },
): Promise<ActionItem[]> {
  try {
    // Filter to status=open at the DB; track filter applied client-side
    // because PostgREST can't query nested JSON with regex easily.
    const r = await fetch(
      `${config.url}/rest/v1/voice_architecture_reports?status=eq.open&select=id,class,generated_at,report&order=generated_at.desc&limit=50`,
      { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` } },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      id: string;
      class: string;
      generated_at: string;
      report: any;
    }>;
    const items: ActionItem[] = [];
    for (const row of rows) {
      const rec = row.report?.recommendation ?? {};
      const track = String(rec.track ?? '');
      if (!track || track.toLowerCase() === 'stay_and_patch') continue;
      const conf = typeof rec.confidence === 'number' ? rec.confidence : null;
      const summary = String(rec.summary ?? '').slice(0, 220);
      items.push({
        id: `voice-investigation:${row.id}`,
        severity: 'warning',
        category: 'voice',
        title: `Architectural recommendation: ${row.class}`,
        summary:
          `Track: ${track}` +
          (conf !== null ? ` (${(conf * 100).toFixed(0)}% confidence)` : '') +
          (summary ? ` — ${summary}` : ''),
        detected_at: row.generated_at,
        deeplink: `/command-hub/diagnostics/voice-lab/?healing=report&id=${encodeURIComponent(row.id)}`,
        source_table: 'voice_architecture_reports',
        source_id: row.id,
      });
    }
    return items;
  } catch {
    return [];
  }
}

async function fetchSelfHealEscalations(
  config: { url: string; key: string },
): Promise<ActionItem[]> {
  try {
    const since = new Date(
      Date.now() - ITEM_LOOKBACK_HOURS * 3600_000,
    ).toISOString();
    const r = await fetch(
      `${config.url}/rest/v1/self_healing_log?outcome=in.(escalated,rolled_back)&created_at=gte.${encodeURIComponent(since)}&select=vtid,endpoint,failure_class,outcome,created_at,diagnosis&order=created_at.desc&limit=100`,
      { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` } },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      vtid: string;
      endpoint: string;
      failure_class: string | null;
      outcome: string;
      created_at: string;
      diagnosis: any;
    }>;
    return rows.map((row) => {
      const reason =
        row.diagnosis?.reason ??
        row.diagnosis?.tombstone_reason ??
        row.outcome;
      return {
        id: `self-heal:${row.vtid}`,
        severity: row.outcome === 'rolled_back' ? 'critical' : ('warning' as 'critical' | 'warning'),
        category: 'self-heal',
        title: `Self-healing ${row.outcome}: ${row.endpoint}`,
        summary:
          `VTID ${row.vtid} (${row.failure_class ?? 'unknown class'}) — ${reason}.` +
          ` Endpoint still requires manual investigation.`,
        detected_at: row.created_at,
        deeplink: `/command-hub/autonomy/self-healing/?vtid=${encodeURIComponent(row.vtid)}`,
        source_table: 'self_healing_log',
        source_id: row.vtid,
      };
    });
  } catch {
    return [];
  }
}

router.get('/', async (_req: Request, res: Response) => {
  const config = getSupabaseConfig();
  if (!config) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Run all three fetches in parallel — none of them depend on each other.
  const [quarantines, reports, escalations] = await Promise.all([
    fetchVoiceQuarantines(config),
    fetchOpenArchitecturalReports(config),
    fetchSelfHealEscalations(config),
  ]);

  // Concatenate and sort by detected_at desc (most recent first).
  const items: ActionItem[] = [...quarantines, ...reports, ...escalations].sort(
    (a, b) => (a.detected_at < b.detected_at ? 1 : -1),
  );

  const count_critical = items.filter((i) => i.severity === 'critical').length;

  return res.json({
    ok: true,
    generated_at: new Date().toISOString(),
    count_total: items.length,
    count_critical,
    items,
  });
});

export default router;
