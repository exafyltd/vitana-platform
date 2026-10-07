// VTID-04963 — real members' reminders are dispatched by production, not by
// staging. Staging shares the production database, so the reminders loop and
// the audiobook daily reminder refuse to run there unless
// REMINDERS_STAGING_DISPATCH_OVERRIDE is exactly "true". Phase 1 keeps that
// override on for staging until production is verified dispatching.
import { readFileSync } from 'fs';
import { join } from 'path';
import { sharedDbLoopAllowed } from '../src/env';
import { isInProcessDispatchEnabled } from '../src/services/reminders-dispatch';
import { isAudiobookReminderLoopEnabled } from '../src/services/guided-journey/audiobook-reminder-dispatch';

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

describe('sharedDbLoopAllowed', () => {
  test('production (VITANA_ENV unset — the real prod state) is allowed', () => {
    expect(sharedDbLoopAllowed('X_OVERRIDE', env({}))).toBe(true);
  });
  test('VITANA_ENV=production is allowed', () => {
    expect(sharedDbLoopAllowed('X_OVERRIDE', env({ VITANA_ENV: 'production' }))).toBe(true);
  });
  test('staging needs the override exactly "true"', () => {
    expect(sharedDbLoopAllowed('X_OVERRIDE', env({ VITANA_ENV: 'staging' }))).toBe(false);
    expect(sharedDbLoopAllowed('X_OVERRIDE', env({ VITANA_ENV: 'staging', X_OVERRIDE: 'TRUE' }))).toBe(false);
    expect(sharedDbLoopAllowed('X_OVERRIDE', env({ VITANA_ENV: 'staging', X_OVERRIDE: 'true' }))).toBe(true);
  });
});

describe('isInProcessDispatchEnabled', () => {
  test('production with the flag → on (VITANA_ENV unset or production)', () => {
    expect(isInProcessDispatchEnabled('true', env({}))).toBe(true);
    expect(isInProcessDispatchEnabled('true', env({ VITANA_ENV: 'production' }))).toBe(true);
  });
  test('staging with the flag but no override → off', () => {
    expect(isInProcessDispatchEnabled('true', env({ VITANA_ENV: 'staging' }))).toBe(false);
  });
  test('staging with the flag and the override → on', () => {
    expect(isInProcessDispatchEnabled('true', env({ VITANA_ENV: 'staging', REMINDERS_STAGING_DISPATCH_OVERRIDE: 'true' }))).toBe(true);
  });
  test('flag off → off everywhere', () => {
    expect(isInProcessDispatchEnabled('false', env({}))).toBe(false);
    expect(isInProcessDispatchEnabled(undefined, env({ VITANA_ENV: 'staging', REMINDERS_STAGING_DISPATCH_OVERRIDE: 'true' }))).toBe(false);
  });
});

describe('isAudiobookReminderLoopEnabled', () => {
  const on = { REMINDERS_INPROCESS_DISPATCH_ENABLED: 'true' };
  test('production with the flag → on', () => {
    expect(isAudiobookReminderLoopEnabled(env(on))).toBe(true);
  });
  test('the audiobook kill switch still wins, in production and on staging', () => {
    expect(isAudiobookReminderLoopEnabled(env({ ...on, AUDIOBOOK_REMINDERS_DISABLED: 'true' }))).toBe(false);
    expect(isAudiobookReminderLoopEnabled(env({ ...on, VITANA_ENV: 'staging', REMINDERS_STAGING_DISPATCH_OVERRIDE: 'true', AUDIOBOOK_REMINDERS_DISABLED: 'true' }))).toBe(false);
  });
  test('staging without the override → off; with it → on', () => {
    expect(isAudiobookReminderLoopEnabled(env({ ...on, VITANA_ENV: 'staging', REMINDERS_STAGING_DISPATCH_OVERRIDE: 'false' }))).toBe(false);
    expect(isAudiobookReminderLoopEnabled(env({ ...on, VITANA_ENV: 'staging', REMINDERS_STAGING_DISPATCH_OVERRIDE: 'true' }))).toBe(true);
  });
});

describe('deploy workflows (phase 1)', () => {
  const wf = (f: string) => readFileSync(join(__dirname, '../../../.github/workflows', f), 'utf8');
  test('production pins the reminders loop on', () => {
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).toMatch(/\{name:"REMINDERS_INPROCESS_DISPATCH_ENABLED", value:"true"\}/);
  });
  test('production never carries the staging override', () => {
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toContain('REMINDERS_STAGING_DISPATCH_OVERRIDE');
  });
  test('staging keeps dispatching until phase 2 (override pinned "true")', () => {
    const stage = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(stage).toContain('{name:"REMINDERS_INPROCESS_DISPATCH_ENABLED", value:"true"}');
    expect(stage).toContain('{name:"REMINDERS_STAGING_DISPATCH_OVERRIDE", value:"true"}');
  });
});
