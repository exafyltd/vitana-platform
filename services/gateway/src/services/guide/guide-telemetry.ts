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
  | 'guide.feature_introduction.recorded';

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
