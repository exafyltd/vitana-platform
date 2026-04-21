/**
 * Proactive Guide — OASIS telemetry helpers.
 *
 * Single emit() facade so all guide events use a consistent vtid + source +
 * topic naming. Phase 0.5 starts with opener and dismissal events; later
 * phases add scoring + learning telemetry.
 */

import { emitOasisEvent } from '../oasis-event-service';

const VTID = 'PROACTIVE-GUIDE';
const SOURCE = 'guide';

export type GuideEventType =
  | 'guide.opener.shown'
  | 'guide.opener.suppressed_by_pause'
  | 'guide.opener.no_candidate'
  | 'guide.dismissal.pause_created'
  | 'guide.dismissal.pause_cleared'
  | 'guide.flag.disabled'
  // Phase G — VTID-01932
  | 'guide.feature_introduction.recorded'
  // Phase F — VTID-01933 conversation continuity
  | 'guide.session_summary.recorded'
  // Phase E — VTID-01935 D43 adaptation applier
  | 'guide.adaptation.applied'
  // Phase C — VTID-01936 pattern extraction
  | 'guide.patterns.extracted'
  // Phase H — VTID-01945 proactive presence pacer
  | 'guide.presence.touch_recorded'
  | 'guide.presence.touch_acknowledged'
  | 'guide.presence.touch_dismissed';

export async function emitGuideTelemetry(
  type: GuideEventType,
  payload: Record<string, unknown>,
  status: 'info' | 'success' | 'warning' | 'error' = 'info',
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type,
      source: SOURCE,
      status,
      message: type,
      payload,
    });
  } catch (err: any) {
    // Telemetry must never break the guide — log and move on.
    console.warn(`[Guide:telemetry] failed to emit ${type}:`, err?.message);
  }
}
