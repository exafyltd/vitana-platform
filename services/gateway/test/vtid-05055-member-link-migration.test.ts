// VTID-05055 — migration contract for member-confirmed partner links
// (Health Hub Phase 0 / D8), plus the gateway registries that must agree with it.
//
//   - additive only: ADD COLUMN IF NOT EXISTS, no DROP / RLS change / backfill
//   - the member_link_status CHECK, the declined-users array, the partial index
//   - the partner_link_request notification is switched ON exactly like
//     VTID-04926 (insert ON CONFLICT DO NOTHING + flip an auto-registered-off row)
//   - the gateway knows the type (notification config + admin catalog) and
//     the new OASIS event types, and the notification text is in every
//     translated locale (DE du-form)

import fs from 'fs';
import path from 'path';
import { NOTIFICATION_CATALOG } from '../src/services/notification-controls/notification-catalog';
import { tt } from '../src/i18n/catalog';

const MIGRATIONS = path.join(__dirname, '../../../supabase/migrations');
const file = fs.readdirSync(MIGRATIONS).find((f) => /_vtid_05055_partner_health_member_link_confirmation\.sql$/.test(f));
const sql = file ? fs.readFileSync(path.join(MIGRATIONS, file), 'utf8') : '';
const code = sql.replace(/--[^\n]*/g, '');

describe('VTID-05055 migration', () => {
  it('exists', () => {
    expect(file).toBe('20261010190000_vtid_05055_partner_health_member_link_confirmation.sql');
  });

  it('is additive only — no drops, no RLS/policy changes, no deletes', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|POLICY|FUNCTION|CONSTRAINT)\b/i);
    expect(code).not.toMatch(/\b(CREATE|ALTER)\s+POLICY\b/i);
    expect(code).not.toMatch(/\b(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('adds every proposal column idempotently, all nullable except the declined-users array', () => {
    for (const col of [
      'member_link_status TEXT',
      'proposed_user_id UUID',
      'proposed_tenant_id UUID',
      'proposed_test_name TEXT',
      'proposed_external_order_ref TEXT',
      'proposed_by_admin_id UUID',
      'proposed_at TIMESTAMPTZ',
      'member_decided_at TIMESTAMPTZ',
    ]) {
      expect(code).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS member_declined_user_ids UUID\[\] NOT NULL DEFAULT '\{\}'/);
    // The new columns must not carry NOT NULL (existing rows would fail).
    const notNulls = code.match(/ADD COLUMN IF NOT EXISTS \w+ [^,;]*NOT NULL/g) ?? [];
    expect(notNulls).toEqual([expect.stringContaining('member_declined_user_ids')]);
  });

  it('constrains member_link_status to the three states', () => {
    expect(code).toMatch(/CHECK \(member_link_status IN \('pending_member', 'confirmed', 'declined'\)\)/);
  });

  it('indexes pending requests by the proposed member (member reads are scoped by user)', () => {
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS partner_health_result_inbox_pending_member_idx\s+ON public\.partner_health_result_inbox \(proposed_user_id\)\s+WHERE member_link_status = 'pending_member'/);
  });

  it('switches partner_link_request ON exactly like VTID-04926 (idempotent, keeps an admin "off")', () => {
    const precedent = fs.readFileSync(path.join(MIGRATIONS, '20261006150000_vtid_04926_mention_notification_types.sql'), 'utf8');
    const shape = (s: string) => s
      .replace(/--[^\n]*/g, '')
      .replace(/'VTID-\d+:[^']*'/g, "'<reason>'")
      .replace(/\(VALUES \('[\s\S]*?'\)\) AS/g, '(VALUES <types>) AS')
      .replace(/type IN \([^)]*\)/g, 'type IN (<types>)');
    const seedStart = code.indexOf('INSERT INTO public.notification_type_controls');
    const ours = shape(code.slice(seedStart)).replace(/\s+/g, ' ').trim();
    const theirs = shape(precedent.slice(precedent.indexOf('INSERT INTO public.notification_type_controls'), precedent.indexOf('UPDATE public.notification_categories'))).replace(/\s+/g, ' ').trim();
    expect(ours).toBe(theirs);
    expect(code).toContain("(VALUES ('partner_link_request'))");
    expect(code).toContain("WHERE type IN ('partner_link_request')");
    expect(code).toMatch(/ON CONFLICT \(tenant_id, type, source_key\) DO NOTHING/);
  });
});

describe('VTID-05055 gateway registries agree with the migration', () => {
  it('the admin notification catalog lists partner_link_request as member/health with localized text', () => {
    const entry = NOTIFICATION_CATALOG.get('partner_link_request');
    expect(entry).toMatchObject({ audience: 'member', group: 'health', text: 'ready' });
    expect(entry!.label.de).toBe('Ist das dein Test?');
  });

  it('the notification type config sends it as push + in-app', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/notification-service.ts'), 'utf8');
    expect(src).toMatch(/partner_link_request:\s*\{ channel: 'push_and_inapp',\s*priority: 'p1', category: 'health' \}/);
  });

  it('the OASIS event union has the new health_test.* types', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/types/cicd.ts'), 'utf8');
    for (const t of ['health_test.staff_read', 'health_test.link_proposed', 'health_test.link_declined', 'health_test.partner_key_mismatch']) {
      expect(src).toContain(`| '${t}'`);
    }
  });

  it('the notification text is translated in every shipped locale, DE in du-form', () => {
    const params = { partner_name: 'DoctorBox', test_name: 'Vitamin D' };
    expect(tt('notif.partner_link_request.title', 'de')).toBe('Ist das dein Test?');
    const de = tt('notif.partner_link_request.body', 'de', params);
    expect(de).toContain('DoctorBox');
    expect(de).toContain('Vitamin D');
    expect(de).not.toMatch(/\b(Sie|Ihr|Ihnen|Ihre)\b/);
    const en = tt('notif.partner_link_request.body', 'en', params);
    for (const lc of ['es', 'sr', 'fr', 'pl', 'pt', 'ru', 'tr', 'zh'] as const) {
      const body = tt('notif.partner_link_request.body', lc, params);
      expect(body).toContain('DoctorBox');
      expect(body).toContain('Vitamin D');
      expect(body).not.toBe(en);
    }
  });
});
