/**
 * VTID-04471 — partner account model: lifecycle rules, type→vertical and
 * lifecycle→status mappings (and their parity with the SQL migration),
 * company-fact validation.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  PARTNER_TYPES,
  canTransition,
  isLifecycleState,
  isPartnerType,
  parseCompanyFacts,
  statusForLifecycle,
  verticalForPartnerType,
} from '../src/services/partner-lifecycle';

const MIGRATION = readFileSync(
  join(__dirname, '../../../supabase/migrations/20260924130000_vtid_04471_partner_account_model.sql'),
  'utf8',
);

function sqlList(constraint: string): string[] {
  const m = MIGRATION.match(new RegExp(`${constraint}\\s+CHECK \\([a-z_]+ IN \\(([^)]*)\\)`));
  if (!m) throw new Error(`constraint ${constraint} not found in migration`);
  return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

describe('lifecycle rules (spec §5.2)', () => {
  it('walks the happy path draft → submitted → verifying → live', () => {
    expect(canTransition('draft', 'submitted')).toBe(true);
    expect(canTransition('submitted', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'live')).toBe(true);
  });

  it('never skips verification', () => {
    expect(canTransition('draft', 'live')).toBe(false);
    expect(canTransition('submitted', 'live')).toBe(false);
    expect(canTransition('needs_action', 'live')).toBe(false);
  });

  it('loops needs_action back through verifying', () => {
    expect(canTransition('verifying', 'needs_action')).toBe(true);
    expect(canTransition('needs_action', 'verifying')).toBe(true);
  });

  it('lets an exception review end live, needs_action or rejected', () => {
    expect(canTransition('verifying', 'exception')).toBe(true);
    for (const to of ['live', 'needs_action', 'rejected'] as const) expect(canTransition('exception', to)).toBe(true);
  });

  it('pauses and resumes live, suspends and reinstates', () => {
    expect(canTransition('live', 'paused')).toBe(true);
    expect(canTransition('paused', 'live')).toBe(true);
    expect(canTransition('live', 'suspended')).toBe(true);
    expect(canTransition('suspended', 'live')).toBe(true);
    expect(canTransition('paused', 'suspended')).toBe(false);
  });

  it('treats rejected as terminal', () => {
    for (const to of LIFECYCLE_STATES) expect(canTransition('rejected', to)).toBe(false);
  });

  it('only names known states in the transition table', () => {
    for (const [from, tos] of Object.entries(LIFECYCLE_TRANSITIONS)) {
      expect(isLifecycleState(from)).toBe(true);
      for (const to of tos) expect(isLifecycleState(to)).toBe(true);
    }
  });
});

describe('parity with the SQL migration', () => {
  it('has the same partner_type vocabulary', () => {
    expect(sqlList('partner_organizations_partner_type_check')).toEqual([...PARTNER_TYPES]);
  });

  it('has the same lifecycle vocabulary', () => {
    expect(sqlList('partner_organizations_lifecycle_state_check')).toEqual([...LIFECYCLE_STATES]);
  });

  it('maps lifecycle → legacy status the same way as partner_org_status_for_lifecycle()', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.partner_org_status_for_lifecycle'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    const explicit: Record<string, string> = {};
    for (const m of body.matchAll(/WHEN '([a-z_]+)'\s+THEN '([a-z_]+)'/g)) explicit[m[1]] = m[2];
    const fallback = body.match(/ELSE '([a-z_]+)'/)![1];
    for (const state of LIFECYCLE_STATES) {
      expect([state, statusForLifecycle(state)]).toEqual([state, explicit[state] ?? fallback]);
    }
  });

  it('maps partner_type → vertical the same way as partner_org_vertical_for_type()', () => {
    const health = MIGRATION.match(/p_partner_type IN \(([^)]*)\) THEN 'health'/)![1]
      .split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    for (const t of PARTNER_TYPES) {
      expect([t, verticalForPartnerType(t)]).toEqual([t, health.includes(t) ? 'health' : 'general']);
    }
  });
});

describe('parseCompanyFacts', () => {
  it('accepts and normalises valid facts', () => {
    expect(parseCompanyFacts({ legal_name: '  Praxis Nord GmbH ', country: 'de', vat_id: 'DE123456789', website: 'https://praxis.example' }))
      .toEqual({ ok: true, facts: { legal_name: 'Praxis Nord GmbH', country: 'DE', vat_id: 'DE123456789', website: 'https://praxis.example/' } });
  });

  it('leaves absent and empty fields out', () => {
    expect(parseCompanyFacts({ legal_name: '', country: null })).toEqual({ ok: true, facts: {} });
    expect(parseCompanyFacts(undefined)).toEqual({ ok: true, facts: {} });
  });

  it('rejects invalid values instead of dropping them', () => {
    expect(parseCompanyFacts({ country: 'DEU' }).ok).toBe(false);
    expect(parseCompanyFacts({ website: 'javascript:alert(1)' }).ok).toBe(false);
    expect(parseCompanyFacts({ website: 'not a url' }).ok).toBe(false);
    expect(parseCompanyFacts({ legal_name: 'x'.repeat(201) }).ok).toBe(false);
    expect(parseCompanyFacts({ vat_id: 42 }).ok).toBe(false);
  });

  it('knows its type guards', () => {
    expect(isPartnerType('lab')).toBe(true);
    expect(isPartnerType('bank')).toBe(false);
  });
});
