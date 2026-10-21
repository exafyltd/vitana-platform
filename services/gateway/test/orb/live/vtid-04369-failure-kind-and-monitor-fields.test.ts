/**
 * VTID-04369 (WS-0.6):
 *  - `nova_validation` carries a failure_kind so the three unrelated failures
 *    that share the code can be counted apart;
 *  - every `greeting_sent` diag carries the Monitor columns, not only
 *    conv_resume.
 */

import * as fs from 'fs';
import * as path from 'path';

import { classifyNovaFailureKind } from '../../../src/orb/live/upstream/nova-sonic-live-client';
import {
  withGreetingMonitorFields,
  registerForOpener,
} from '../../../src/services/conversation/greeting-monitor-fields';

describe('classifyNovaFailureKind — the real diagnostics measured on production', () => {
  it.each([
    ['RequestId=0883e6e2 : This request has been blocked by our content filters.', 'content_filter'],
    ['RequestId=abc : Error(s):\nError 1 : This request has been blocked by our content filters.', 'content_filter'],
    [
      'RequestId=0374 : Timed out waiting for audio bytes or interactive content. Please ensure gaps between audio bytes and interactive content are less than 55 seconds',
      'idle_timeout',
    ],
    [
      'RequestId=x : Timed out waiting for audio bytes or interactive content. Please ensure gaps between audio bytes and interactive content are less than 295 seconds',
      'idle_timeout',
    ],
    ['RequestId=0726 : Error(s):\nError 1 : All contents must be closed before ending prompt', 'prompt_protocol'],
    ['RequestId=z : something new', 'other'],
    [undefined, 'other'],
  ])('%p → %s', (diag, kind) => {
    expect(classifyNovaFailureKind('nova_validation', diag as string | undefined)).toBe(kind);
  });

  it.each(['nova_stream_error', 'nova_throttled', 'nova_access_denied'])('is null for %s', (code) => {
    expect(classifyNovaFailureKind(code, 'This request has been blocked by our content filters.')).toBeNull();
  });
});

describe('withGreetingMonitorFields', () => {
  it('keeps every value a rung reports and adds nothing it did not compute', () => {
    const d = withGreetingMonitorFields(
      { wake_opener: 'conv_resume', register: 'returning_same_day', bucket: 'same_day', nba: 'diary', nba_domain: 'health', current_route: '/diary', lang: 'de', prompt_len: 900 },
      { bucket: 'recent', currentRoute: '/home', lang: 'en' },
    );
    expect(d).toEqual({
      wake_opener: 'conv_resume',
      register: 'returning_same_day',
      bucket: 'same_day',
      nba: 'diary',
      nba_domain: 'health',
      current_route: '/diary',
      lang: 'de',
      prompt_len: 900,
    });
  });

  it('fills blank columns from the session and a derived register; nba stays null', () => {
    const d = withGreetingMonitorFields(
      { lang: 'de', prompt_len: 1200, wake_opener: 'override_v2' },
      { bucket: 'recent', currentRoute: '/autopilot/my-journey', lang: 'en' },
    );
    expect(d).toMatchObject({
      wake_opener: 'override_v2',
      register: 'continuation',
      bucket: 'recent',
      current_route: '/autopilot/my-journey',
      lang: 'de',
      nba: null,
      nba_domain: null,
    });
  });

  it('the legacy default (no wake_opener) is labelled and registered as default', () => {
    expect(withGreetingMonitorFields({ lang: 'en', prompt_len: 600 }, {})).toMatchObject({
      wake_opener: 'legacy_default',
      register: 'default',
      bucket: null,
      current_route: null,
    });
  });

  it.each([
    ['silent_reconnect', 'reconnect'],
    ['safe_fast_newday', 'daily_briefing'],
    ['newday_overview', 'daily_briefing'],
    ['day_close', 'day_close'],
    ['conv_resume', 'resume'],
    ['safe_fast_proactive', 'continuation'],
    ['safe_fast_pending_context', 'pending_context'],
    ['something_else', 'default'],
  ])('registerForOpener(%s) → %s', (w, r) => expect(registerForOpener(w)).toBe(r));
});

describe('wiring (source contract)', () => {
  const root = path.join(__dirname, '../../../src');
  const orbLive = fs.readFileSync(path.join(root, 'routes/orb-live.ts'), 'utf8');
  const handler = fs.readFileSync(path.join(root, 'orb/live/session/upstream-message-handler.ts'), 'utf8');
  const nova = fs.readFileSync(path.join(root, 'orb/live/upstream/nova-sonic-live-client.ts'), 'utf8');

  it('no greeting_sent diag is emitted without the Monitor columns', () => {
    expect(orbLive).not.toMatch(/emitDiag\(session, 'greeting_sent', (_sfDecision|decision)\.diag\)/);
    expect((orbLive.match(/emitDiag\(session, 'greeting_sent', withGreetingMonitorFields\(/g) || []).length).toBe(2);
  });

  it('the upstream_error diag carries failure_kind, set by the Nova client', () => {
    expect(handler).toMatch(/failure_kind: \(event as \{ failure_kind\?: string \}\)\.failure_kind \?\? null/);
    expect(nova).toMatch(/classifyNovaFailureKind\(err\.code, err\.diagnostic\)/);
  });
});
