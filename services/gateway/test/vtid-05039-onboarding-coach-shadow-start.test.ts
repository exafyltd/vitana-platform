/**
 * VTID-05039 — the onboarding coach runs in shadow mode in production.
 *
 * Pins the three things slice 1 (VTID-04892) left unset, so a later edit
 * cannot silently switch the coach off, on in the wrong place, or to sending:
 *   - the production deploy workflow pins FEATURE_ONBOARDING_ASSISTANT_ENV to a
 *     recognised value and VOA_ROLLOUT_DATE to a valid date, and never sets
 *     VOA_MODE (shadow is the only mode until a sending slice says otherwise);
 *   - the staging deploy workflow sets none of them (staging shares the
 *     production database; the coach resolves disabled-on-staging anyway);
 *   - exactly one daily scheduler job calls the tick, with gateway_internal auth.
 * And the pinned values resolve to shadow mode through the real config code.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveCoachConfig } from '../src/services/onboarding-coach/config';
import { isRecognisedFeatureFlagValue } from '../src/services/feature-flags';

const ROOT = path.join(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const prod = read('.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml');
const stage = read('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml');
const cron = read('scripts/aws/setup-eventbridge-cron-migration.sh');

const pinned = (name: string) => {
  const m = prod.match(new RegExp(`\\{name:"${name}", value:"([^"]*)"\\}`));
  return m ? m[1] : undefined;
};

describe('VTID-05039: production pins the coach in shadow mode', () => {
  it('pins FEATURE_ONBOARDING_ASSISTANT_ENV to a recognised value that is live on prod', () => {
    const v = pinned('FEATURE_ONBOARDING_ASSISTANT_ENV');
    expect(v).toBe('staging+prod');
    expect(isRecognisedFeatureFlagValue(v)).toBe(true);
  });

  it('pins VOA_ROLLOUT_DATE to a valid calendar date', () => {
    const v = pinned('VOA_ROLLOUT_DATE') ?? '';
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10)).toBe(v);
  });

  it('never sets VOA_MODE (no sending mode)', () => {
    expect(prod).not.toMatch(/name:"VOA_MODE"/);
    expect(stage).not.toMatch(/VOA_MODE/);
  });

  it('the staging workflow sets none of the coach switches', () => {
    expect(stage).not.toMatch(/FEATURE_ONBOARDING_ASSISTANT_ENV|VOA_ROLLOUT_DATE/);
  });

  it('the pinned values resolve to shadow on production and stay off on staging', () => {
    const env = { VOA_ROLLOUT_DATE: pinned('VOA_ROLLOUT_DATE') } as NodeJS.ProcessEnv;
    expect(resolveCoachConfig(env, { isStaging: false, featureLive: true })).toMatchObject({ mode: 'shadow', reason: 'shadow' });
    expect(resolveCoachConfig(env, { isStaging: true, featureLive: true }).mode).toBe('disabled-on-staging');
  });
});

describe('VTID-05039: one daily scheduler job for the tick', () => {
  const rows = cron.split('\n').filter((l) => l.includes('/onboarding-coach-tick'));

  it('exactly one job row targets the tick', () => {
    expect(rows).toHaveLength(1);
  });

  it('runs once a day, against the production gateway token, with gateway_internal auth', () => {
    const [name, schedule, tz, route, body, extra] = rows[0].trim().replace(/^"|"$/g, '').split('|');
    expect(name).toBe('gateway-onboarding-coach-tick');
    expect(schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(tz).toBe('UTC');
    expect(route).toBe('/api/v1/scheduled-notifications/onboarding-coach-tick');
    expect(body).toBe('{}');
    expect(extra).toContain('\\"auth\\":\\"gateway_internal\\"');
    expect(extra).toContain('$PROD_INTERNAL_TOKEN_SECRET_ID');
    expect(extra).not.toContain('gateway_url');
  });
});
