/**
 * VTID-04268: Command Hub Autopilot supervisor visibility — the Dev
 * Autopilot config screen becomes writable for the safe numeric knobs.
 *
 * Pins the pure validator (`validateConfigUpdate`) in isolation: bounds
 * per field, unknown-field rejection (especially the two fields this VTID
 * deliberately keeps read-only — allow_scope/deny_scope — plus kill_switch,
 * which already has its own route), and integer/finite-number checks.
 */

import {
  validateConfigUpdate,
  CONFIG_NUMERIC_FIELDS,
} from '../src/services/dev-autopilot-config-update';

describe('CONFIG_NUMERIC_FIELDS', () => {
  it('never includes allow_scope, deny_scope, or kill_switch (VTID-04268 scope decision)', () => {
    expect(CONFIG_NUMERIC_FIELDS).not.toHaveProperty('allow_scope');
    expect(CONFIG_NUMERIC_FIELDS).not.toHaveProperty('deny_scope');
    expect(CONFIG_NUMERIC_FIELDS).not.toHaveProperty('kill_switch');
  });

  it('includes the nine safe numeric fields', () => {
    expect(Object.keys(CONFIG_NUMERIC_FIELDS).sort()).toEqual(
      [
        'auto_archive_days',
        'concurrency_cap',
        'cooldown_minutes',
        'daily_budget',
        'eager_plan_top_k',
        'max_auto_fix_depth',
        'post_deploy_verification_window_minutes',
        'reject_suppression_days',
        'select_all_cap',
      ].sort(),
    );
  });
});

describe('validateConfigUpdate', () => {
  it('accepts a single valid field and returns a patch', () => {
    const result = validateConfigUpdate({ daily_budget: 25 });
    expect(result).toEqual({ ok: true, patch: { daily_budget: 25 } });
  });

  it('accepts multiple valid fields in one patch', () => {
    const result = validateConfigUpdate({ daily_budget: 10, concurrency_cap: 3 });
    expect(result).toEqual({ ok: true, patch: { daily_budget: 10, concurrency_cap: 3 } });
  });

  it('accepts a field at its exact min bound', () => {
    const result = validateConfigUpdate({ daily_budget: 0 });
    expect(result.ok).toBe(true);
  });

  it('accepts a field at its exact max bound', () => {
    const result = validateConfigUpdate({ concurrency_cap: 50 });
    expect(result.ok).toBe(true);
  });

  it('rejects a value below the min bound', () => {
    const result = validateConfigUpdate({ concurrency_cap: 0 });
    expect(result).toEqual({ ok: false, error: 'concurrency_cap must be between 1 and 50' });
  });

  it('rejects a value above the max bound', () => {
    const result = validateConfigUpdate({ concurrency_cap: 51 });
    expect(result).toEqual({ ok: false, error: 'concurrency_cap must be between 1 and 50' });
  });

  it('rejects a non-integer number', () => {
    const result = validateConfigUpdate({ daily_budget: 5.5 });
    expect(result).toEqual({ ok: false, error: 'daily_budget must be an integer' });
  });

  it('rejects a non-numeric value', () => {
    const result = validateConfigUpdate({ daily_budget: '10' });
    expect(result).toEqual({ ok: false, error: 'daily_budget must be a finite number' });
  });

  it('rejects NaN and Infinity', () => {
    expect(validateConfigUpdate({ daily_budget: NaN }).ok).toBe(false);
    expect(validateConfigUpdate({ daily_budget: Infinity }).ok).toBe(false);
  });

  it('rejects an unknown field even alongside a valid one', () => {
    const result = validateConfigUpdate({ daily_budget: 5, not_a_field: 1 });
    expect(result).toEqual({ ok: false, error: 'unknown or unwritable field(s): not_a_field' });
  });

  it('rejects allow_scope explicitly (the security-sensitive field this VTID excludes)', () => {
    const result = validateConfigUpdate({ allow_scope: ['services/gateway/**'] });
    expect(result).toEqual({ ok: false, error: 'unknown or unwritable field(s): allow_scope' });
  });

  it('rejects deny_scope explicitly', () => {
    const result = validateConfigUpdate({ deny_scope: ['CLAUDE.md'] });
    expect(result).toEqual({ ok: false, error: 'unknown or unwritable field(s): deny_scope' });
  });

  it('rejects kill_switch explicitly (has its own route, VTID-04264)', () => {
    const result = validateConfigUpdate({ kill_switch: true });
    expect(result).toEqual({ ok: false, error: 'unknown or unwritable field(s): kill_switch' });
  });

  it('rejects an empty object', () => {
    const result = validateConfigUpdate({});
    expect(result).toEqual({ ok: false, error: 'no fields provided' });
  });

  it('rejects a non-object body', () => {
    expect(validateConfigUpdate(null).ok).toBe(false);
    expect(validateConfigUpdate(undefined).ok).toBe(false);
    expect(validateConfigUpdate('daily_budget').ok).toBe(false);
    expect(validateConfigUpdate(42).ok).toBe(false);
  });

  it('rejects an array body', () => {
    const result = validateConfigUpdate([1, 2, 3]);
    expect(result.ok).toBe(false);
  });

  it.each(Object.keys(CONFIG_NUMERIC_FIELDS))('accepts %s at its min and max bounds', (field) => {
    const bounds = CONFIG_NUMERIC_FIELDS[field];
    expect(validateConfigUpdate({ [field]: bounds.min }).ok).toBe(true);
    expect(validateConfigUpdate({ [field]: bounds.max }).ok).toBe(true);
    expect(validateConfigUpdate({ [field]: bounds.max + 1 }).ok).toBe(false);
  });
});
