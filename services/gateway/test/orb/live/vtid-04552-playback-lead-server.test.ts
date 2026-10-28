/**
 * VTID-04552 (ORB latency J) — the server switch for the widget's mobile
 * playback lead. Off (default) ⇒ the field is omitted, so every handshake is
 * byte-identical to before.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isMobileLeadFirstOnlyEnabled,
  playbackLeadHandshakeFields,
} from '../../../src/orb/live/playback-lead';

describe('VTID-04552 playback lead server switch', () => {
  it('only the exact string "true" enables it', () => {
    expect(isMobileLeadFirstOnlyEnabled({})).toBe(false);
    expect(isMobileLeadFirstOnlyEnabled({ ORB_MOBILE_LEAD_FIRST_ONLY_ENABLED: 'TRUE' })).toBe(false);
    expect(isMobileLeadFirstOnlyEnabled({ ORB_MOBILE_LEAD_FIRST_ONLY_ENABLED: '1' })).toBe(false);
    expect(isMobileLeadFirstOnlyEnabled({ ORB_MOBILE_LEAD_FIRST_ONLY_ENABLED: 'true' })).toBe(true);
  });

  it('off ⇒ no field at all; on ⇒ exactly playback_lead_first_only: true', () => {
    expect(playbackLeadHandshakeFields({})).toEqual({});
    expect(JSON.stringify({ a: 1, ...playbackLeadHandshakeFields({}) })).toBe('{"a":1}');
    expect(playbackLeadHandshakeFields({ ORB_MOBILE_LEAD_FIRST_ONLY_ENABLED: 'true' })).toEqual({ playback_lead_first_only: true });
  });

  it('is carried on all three handshakes the widget reads (WS session_started, SSE live_api_ready, SSE start response)', () => {
    const route = readFileSync(join(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');
    const ctrl = readFileSync(join(__dirname, '../../../src/orb/live/session/live-session-controller.ts'), 'utf8');
    const ready = route.indexOf("type: 'live_api_ready'");
    const started = route.indexOf("setupComplete: true, // v1 compatibility");
    expect(route.indexOf('...playbackLeadHandshakeFields()', ready)).toBeGreaterThan(ready);
    expect(route.indexOf('...playbackLeadHandshakeFields()', started)).toBeGreaterThan(started);
    expect(route.indexOf('...playbackLeadHandshakeFields()', started) - started).toBeLessThan(1200);
    const resp = ctrl.indexOf('return res.status(200).json({\n    ok: true,\n    session_id: sessionId,');
    expect(ctrl.slice(resp, resp + 400)).toContain('...playbackLeadHandshakeFields()');
  });

  it('the widget reads the field from those same three messages', () => {
    const widget = readFileSync(join(__dirname, '../../../src/frontend/command-hub/orb-widget.js'), 'utf8');
    expect((widget.match(/playback_lead_first_only === true/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});
