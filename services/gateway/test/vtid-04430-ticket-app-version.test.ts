/**
 * VTID-04430 — a ticket filed by voice carries the member app's build stamp
 * (feedback_tickets.app_version), the way a typed ticket does.
 */
import * as fs from 'fs';
import * as path from 'path';

import { normalizeAppVersion } from '../src/orb/live/session/live-session-controller';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('normalizeAppVersion', () => {
  it('keeps a short build stamp', () => {
    expect(normalizeAppVersion('2ec2f78c5a1b')).toBe('2ec2f78c5a1b');
    expect(normalizeAppVersion(' local ')).toBe('local');
  });
  it('drops anything that is not a short plain token', () => {
    expect(normalizeAppVersion(undefined)).toBeNull();
    expect(normalizeAppVersion(42)).toBeNull();
    expect(normalizeAppVersion('')).toBeNull();
    expect(normalizeAppVersion('%VITE_APP_VERSION%')).toBeNull();
    expect(normalizeAppVersion('<script>')).toBeNull();
    expect(normalizeAppVersion('x'.repeat(65))).toBeNull();
  });
});

describe('wiring', () => {
  it('the widget sends the host meta stamp on session start', () => {
    const w = read('src/frontend/command-hub/orb-widget.js');
    expect(w).toContain(`document.querySelector('meta[name="vitana-app-version"]')`);
    expect(w).toContain('startPayload.app_version = _appVer;');
  });
  it('session start stores it, and both voice ticket paths forward it', () => {
    expect(read('src/orb/live/session/live-session-controller.ts')).toContain(
      'app_version: normalizeAppVersion((body as any).app_version),',
    );
    const live = read('src/routes/orb-live.ts');
    expect(live).toContain('              app_version: session.app_version ?? null,\n            },\n          );');
    expect(live).toContain('                app_version: session.app_version ?? null,\n');
    const typed = read('src/services/orb-tools/feedback-settings-tools.ts');
    expect(typed.match(/app_version: appVersion,/g)).toHaveLength(2);
  });
});
